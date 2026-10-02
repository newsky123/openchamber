# Compiled OpenChamber agent tools

## Ownership

OpenChamber supplies a JSON catalog and executes its fixed action allowlist.
The matching OpenCode build includes a statically imported adapter. OpenChamber
never generates a JavaScript plugin or asks OpenCode to import a plugin path.
The names stay `openchamber`, `openchamber_web`, `openchamber_memory`, and
`openchamber_notify`, so existing permissions and message rendering still apply.

`catalog.js` owns the schemas, descriptions, action titles and settings mapping.
`runtime.js` owns the callback credential, caller validation and cancellation.
The shared OpenChamber control service still owns each action's domain behavior.

The four tools expose 14 control actions, 10 browser actions, four memory actions
and one notification action. Session and worktree deletion, project registration
and the CLI-only `schedule.status` action remain unavailable.

## Startup and settings

The managed launcher always passes `--compiled-plugins-only`. A stock CLI that
does not understand this flag fails before reading plugin code. The matching
build also acknowledges the mode in the private startup handshake.

Web and Electron pass `--openchamber-bootstrap` and write one bounded JSON
record to the child's private stdin, then close it. The record contains protocol
version 1, the callback URL, a fresh tool-only capability and the catalog.
Schemas and action titles are data. The record contains no module path or source
code. It is never written to a config file, log, command line or environment.

`createBootstrap()` returns `{ payload, revoke }`. The launcher owns the revoke
callback for that exact child. A stale child's exit cannot clear the replacement's
capability. Restart rotates the capability and cancels outstanding calls. HMR
retains the private credential state and in-flight map while a child survives.

The managed config file contains only `openchamber.agentTools` booleans for
control, web, memory, notify and Code Mode. OpenCode watches this data and
rebuilds its tool catalog without importing anything. Control and web default
on; memory requires both availability and its setting; notify defaults off.
The backend checks the current settings on every call, including calls from a
stale catalog. An unreadable settings file refuses the action.

When the user's environment owns `OPENCODE_CONFIG`, OpenChamber leaves that file
alone and merges the booleans into the child's `OPENCODE_CONFIG_CONTENT`.
Those installs still need a restart to update the engine's catalog. Existing
plugin entries and generated plugin directories are left on disk, but the
compiled-only engine ignores those dynamic loading paths.

## Callback boundary

The compiled adapter sends one action to `POST /api/openchamber/agent-tool`.
It uses Node's direct HTTP client, so proxy environment variables cannot forward
the capability to an HTTP proxy. It follows no redirects. The callback accepts
loopback or the server's concrete local bind address, requires the exact Host
from bootstrap, rejects Origin headers and compares the capability in constant
time. The main API and `/api/notifications/emit` do not accept this capability
as an authentication credential. Their ordinary UI/API authentication remains
unchanged.

The request contains only `tool`, `input` and the engine's `sessionID`.
Unknown tools, cross-tool actions, unsupported parameters and caller-supplied
context/approval fields are rejected. OpenChamber fetches the session by exact ID
and refuses the call if its directory cannot be resolved. A paginated session
list is not used to infer caller authority. Explicit target project/session
parameters retain the control service's existing validation and behavior.

OpenCode's compiled adapter asserts the original tool permission before making
any callback. A model-supplied `confirmed` field grants no permission. Cancellation
from the engine, HTTP disconnect, credential rotation or the session event stream
aborts in-flight work through the shared control service's signal.

This is a code-loading boundary, not a process sandbox. Trusted compiled code
still runs inside OpenCode. Root, same-user debuggers, process memory access and
arbitrary replacement binaries are outside this guarantee.

## Results and runtime differences

Results retain `{ schemaVersion: 1, ok, action, data?, error? }`. Partial failures
remain failures and include the control service's partial-result details. The
compiled adapter preserves native progress metadata and the original names.
Inputs may be nested under `parameters` or flattened; the adapter normalizes
them before calling OpenChamber, and explicit nested values win on a conflict.

- Web and Electron managed engines use the compiled adapter and private bootstrap
- VS Code requires the compiled-only engine but does not supply OpenChamber agent tools
- External OpenCode is not launched or reconfigured by OpenChamber and gets no adapter
- Hosted and Capacitor mobile use the connected server's tools; no tool runs on the client

Focused tests cover every action, catalog data, stale settings, authority inputs,
authentication, rotation, HMR, cancellation and partial results. Launcher tests
cover private-pipe delivery and capability validation. End-to-end validation must
also use the matching compiled OpenCode build, since stock 2.0.21 cannot run this
mode.
