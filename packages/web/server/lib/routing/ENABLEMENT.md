# Enabling Jev routing

`DOCUMENTATION.md` in this folder describes the mechanism. This file covers the
operational question instead: what `OPENCHAMBER_ROUTING_ENABLE=1` actually
switches, what it deliberately does not switch, what leaves the machine once it
is on, and what is still missing before the flag can come off.

## What the flag switches

`isRoutingFeatureAvailable()` reads `process.env.OPENCHAMBER_ROUTING_ENABLE` on
every call and accepts `1`, `true`, `yes` or `on` after trimming and lowercasing
(`feature-flag.js:9`). No build step bakes it in, so the process that starts the
OpenChamber server is the only thing that decides.

| With the variable unset | With it set |
|---|---|
| `/api/routing` and `/api/routing/token` answer 404 (`routes.js:26`) | They serve the config and the key |
| The send-path middleware calls `next()` before reading the body (`routes.js:69`) | It parses JSON on `prompt_async`, `prompt` and `command`, then rewrites `body.model` when it is the sentinel |
| The settings payload carries `routingFeatureAvailable: false` | It carries `true` (`opencode/settings-helpers.js:1021`), which shows Settings → Routing (`SettingsView.tsx:252`) and its command-palette entry (`CommandPalette.tsx:405`) |
| `describe()` returns the unavailable shape and `evaluatePermission` accepts every permission (`runtime.js:68`, `runtime.js:161`) | Both run for real |

By itself the flag shows the user one new Settings page and changes nothing
else. It is necessary, not sufficient.

## From the flag to a working Auto row

`autoReady` is a conjunction of five conditions (`runtime.js:71`). Miss any one
and the model picker has no Auto row.

| Condition | Where the user sets it | Where it lives |
|---|---|---|
| The feature flag | Process environment | Not stored |
| A Jev API key | Settings → Routing, key field | `routing-auth.json`, mode 0600 |
| `enabled` | Settings → Routing, Auto section | `routing.json` |
| A fallback model | Settings → Routing | `routing.json` |
| Two or more enabled categories | Ships satisfied: four built-ins | `routing.json`, only once the user deviates |

While `autoReady` is false, `resolvePromptBody` still honours a sentinel that
reached it by another path: it applies the fallback pair without calling Jev at
all (`runtime.js:145`).

The safety net is a separate gate and a weaker one. `evaluatePermission` needs
the flag, `config.enabled`, `safetyNet.enabled` and a key, and nothing else
(`runtime.js:161`). No fallback model, no category count. A user who never turns
Auto on can still have permissions held, so "no Auto row" and "my permissions
keep stopping" are consistent with each other in a support report.

## Setting the variable per runtime

**CLI and self-hosted.** Prefix the command, or export it in the unit file or
container environment:

```
OPENCHAMBER_ROUTING_ENABLE=1 openchamber serve
```

**Local development.** Same prefix on `bun run --cwd packages/web dev:server`.
The dev HMR script and the Vite build never read the variable; only the server
process does.

**Desktop.** Electron hosts the backend in-process, so the variable has to be in
the Electron main process environment before `startWebUiServer` runs
(`electron/main.mjs:1475`). A packaged app launched from Finder or Explorer does
not inherit a terminal's exports, but `inheritUserShellEnv` runs first
(`electron/main.mjs:1407`) and merges a login-shell snapshot into `process.env`
for every key that is still undefined, skipping only `PATH` and `ARGV0`. The
probe is `$SHELL -il` and then `$SHELL -l` (`electron/shell-environment.mjs:66`),
so `export OPENCHAMBER_ROUTING_ENABLE=1` in `~/.zshrc` or `~/.zprofile` reaches
the packaged app. Nushell users get no snapshot and need the variable in the
launch environment itself. Windows has its own loader and reads the user
environment.

**VS Code.** The extension host runs no OpenChamber server, so
`routingFeatureAvailable` keeps its `false` default (`useUIStore.ts:1370`) and
Auto is never offered. There is nothing to set.

**Mobile.** The hosted surface and the Capacitor shell both connect to an
OpenChamber server and read its settings payload, so the flag belongs on that
server. Nothing to set on the device.

## What leaves the machine

This is the part worth being explicit about, because OpenChamber is otherwise
self-hosted and Auto puts a third party on the send path. Every call goes to
`POST https://api.typesafe.ai/v1/systemone` with the key as a bearer token,
model `jev-latest`, 4 second timeout (`defaults.js:23`).

A routing call carries (`jev.js:16`):

- `state.request`: the composer's non-synthetic text parts joined, or
  `/command args` for a slash command. Never truncated (`runtime.js:27`).
- `state.history`: the last 3 settled turns. A user message keeps its first 600
  characters, an answer its first 300 and last 300 (`defaults.js:70`). Text
  parts only, attached quotes included, no files and no tool payloads
  (`history.js:1`).
- `questions.category.criteria`: the description of every enabled category,
  including any the user wrote.

A safety-net call carries the permission as OpenCode reported it: its type, its
patterns and its metadata (`jev.js:27`). For a bash permission that metadata is
the command line; for an edit it is the path and the patch metadata.

Neither call carries session ids, directory paths, file contents beyond what a
quoted excerpt or patch metadata already holds, or tool output.

The key is stored alone in `routing-auth.json` at mode 0600, separate from
`routing.json`, so the config can be read, shown or exported without carrying
the secret (`store.js:244`).

## What a send costs

| Step | Budget | On failure |
|---|---|---|
| History read from OpenCode | 2500 ms (`runtime.js:16`) | Logged, routing continues on the request alone (`runtime.js:128`) |
| Jev call | 4000 ms cap; the lab measured 250 to 700 ms warm and about 1 s on a cold TLS handshake (`defaults.js:27`) | Fallback model, `reason: 'error'` on the decision |

A normal Auto send therefore adds a local history read plus a Jev round trip of
roughly 0.3 to 1 second before the prompt reaches OpenCode, and about 6.5
seconds in the worst case where both steps time out. The safety net adds one
more call per distinct permission, cached 15 minutes per request id so
reconnect reconciliation does not re-ask (`runtime.js:18`).

## Open work before the flag comes off

### A scheduled task can store the Auto sentinel and dispatch it raw

This is the one correctness gap, and it is reachable without doing anything
unusual.

`ScheduledTaskEditorDialog` seeds a new task's model from the composer's current
selection (`ScheduledTaskEditorDialog.tsx:745`). If the user has Auto selected
and opens "New scheduled task", the draft starts on `openchamber/auto`. The
dialog's `ModelSelector` does not pass `offerAuto`, so the Auto row is not in
the picker, but `isAutoSelected` still renders the trigger as "Auto"
(`ModelSelector.tsx:132`) and `validateDraft` only checks the two strings are
non-empty (`ScheduledTaskEditorDialog.tsx:582`). Server-side normalization is
the same non-empty check (`projects/project-config.js:227`), so the sentinel
persists.

At run time the scheduled-task runtime posts straight to OpenCode without the
rewrite, on all three of its dispatch shapes:

- `runPromptAsync`, which builds `model: { providerID, modelID }`
  (`scheduled-tasks/runtime.js:465`)
- `runScheduledCommand`, which builds `model: "<providerID>/<modelID>"`
  (`scheduled-tasks/runtime.js:544`)
- `createSessionGoal`, which takes the same pair
  (`scheduled-tasks/runtime.js:613`)

OpenCode then receives a provider it does not know and the scheduled run fails.
This breaks the module's own invariant that the sentinel never reaches OpenCode.

Fix both ends. Pass `resolvePromptBody` into `createScheduledTasksRuntime` the
way `createMessageQueueRuntime` already receives it
(`packages/web/server/index.js:949`) and call it on each dispatch shape, which
also gives scheduled runs real routing rather than a silent fallback. Then
refuse the sentinel in the editor, so a task cannot store a model the picker
would not have offered.

The other server-side dispatchers are safe by construction and need no change:
`session-goal/runtime.js:472` and `context-obligatory/runtime.js:113` both take
the provider and model from the last assistant message, which is always a model
OpenCode actually ran.

### A Session Default of Auto survives the flag being removed

`resolveProviderModelSelection` returns `settingsDefaultModel` without checking
it against the provider list (`useConfigStore.ts:252`). Session Defaults does
offer Auto (`DefaultsSettings.tsx:324`), so a user who sets it there and then
loses the flag keeps `openchamber/auto` as the composer selection, and the
rewrite is no longer registered to catch it. Have that helper reject the
sentinel as a settings default while `selectAutoReady` is false. Adding a
sentinel check to the send-path middleware would work too, but it would force
JSON parsing on every send in builds without the feature, which the module
deliberately avoids.

### The flag itself has no test

`agent-memory/feature-flag.test.js` covers its truthy set, its falsy values and
the unset case. Routing's equivalent is only exercised indirectly through
`routes.http.test.js` and `runtime.test.js`. Cheap to add and worth having
before the flag decides anything for real users.

### Held permissions do not survive a restart

`permissionDecisions` is a per-process `Map` (`runtime.js:53`). After a restart,
a permission still pending in OpenCode is evaluated again: one extra Jev call
and one repeated `routing.permission-held` broadcast. The verdict should match,
so this is a cost note rather than a bug, but it belongs in the release
discussion.

### Documentation and release

`OPENCHAMBER_ROUTING_ENABLE` appears in none of the eleven copies of
`environment.mdx` under `packages/docs/content/docs` (English plus ten locales),
which is correct while the feature ships dark. Releasing it means an entry in
all eleven, plus whatever the Settings → Routing page needs in the product
docs. The changelog line stays the
maintainer's call at release time.

## Rolling back

Unset the variable and restart the server. The routes answer 404 again, the
middleware stops parsing bodies, `routingFeatureAvailable` goes false, and the
Settings page and the Auto row disappear. `routing.json` and `routing-auth.json`
are left untouched on disk, so turning the flag back on restores the same
configuration and the same key.

Before unsetting it, clear any Session Defaults model set to Auto, for the
reason above. A queued message that still carries the sentinel is safe: with the
flag off, `describe()` returns no config and `resolvePromptBody` throws a 400
rather than forwarding (`runtime.js:118`), so the queue fails loudly instead of
handing OpenCode a provider it cannot resolve.
