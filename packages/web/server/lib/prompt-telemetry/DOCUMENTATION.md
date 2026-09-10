# Managed Prompt Telemetry

## Purpose

Capture what managed OpenCode actually sends to the model — the assembled
system prompt, the transformed message list, the tool schemas, and the sampling
parameters — so a question like "why did the model not call this tool" can be
answered after the turn is over. None of it survives in the session record on
disk, and no OpenCode API returns it.

Off unless `OPENCHAMBER_PROMPT_TELEMETRY` is truthy (`1`/`true`). The records
hold the user's source, file paths, and conversation in the clear, so this is a
diagnostic the operator turns on, not a default.

## Runtime flow

1. `prepareManagedOpenCodeEnv(configContent)` materializes the plugin under
   `<openchamber-data-dir>/prompt-telemetry/` and appends its `file://` URL
   through `packages/web/server/lib/opencode/managed-plugin-config.js`.
2. `index.js` appends it **last**, after the agent-tool, system-prompt, and
   MCP-reconnect plugins. `Plugin.trigger` runs every plugin's hook in load
   order over one shared mutable output, so only a hook that runs after the
   others sees the value that goes on the wire. Appending it earlier silently
   captures a pre-transform system prompt.
3. Inside one LLM call OpenCode fires, in order:
   `tool.definition` (once per tool) → `experimental.chat.messages.transform`
   → `experimental.chat.system.transform` → `chat.params` → `chat.headers`.
4. The plugin keeps the latest messages and system snapshot per session, and
   commits one record at `chat.params` — the last hook that still knows the
   session, agent, and model.
5. Records append as JSONL to `<plugin-dir>/records/<YYYY-MM-DD>.jsonl`,
   one file per UTC day.

## Correlation

`experimental.chat.messages.transform` receives an empty input object, so the
session comes from the payload instead: every entry in `output.messages` carries
`info.sessionID`. Nothing depends on hook timing to pair the parts of a call.

`tool.definition` carries only `toolID` — no session — so tool schemas are
their own record type rather than a field on the request they belong to, keyed
by a sha256 of description plus parameters and written only when that pair is
new for the process.

## Invariants

- A hook never throws and never rejects. `Plugin.trigger` wraps each hook in
  `Effect.promise`, which turns a rejection into a defect that kills the turn,
  so every hook body is guarded and the write chain swallows its own errors.
- Hooks do not await the write. Appends are serialized through one promise
  chain to stay ordered; `dispose` drains it, and a hard kill loses whatever is
  still queued.
- `chat.headers` is never captured. It carries the provider's credentials.
- `params.options` is captured with credential-shaped keys replaced by
  `[redacted]`: it merges the provider config block, which is where a custom
  OpenAI-compatible provider keeps its key.

## Known limitation

A session's snapshot is kept, not consumed, so a concurrent small-model call on
the same session (title or summary generation, which runs forked and skips
`messages.transform`) can commit a record carrying the main call's message
list. `systemCapturedAt`, `messagesCapturedAt`, `sequence`, and `lastMessageID`
are on every record so a consumer can spot the skew. Consuming the snapshot
instead would trade this for the opposite failure — the main call losing its
messages — which is worse for the diagnostic this exists to serve.

## Record shape

Both types carry `schemaVersion`, `time`, and `directory`.

`type: "request"` — `sessionID`, `sequence` (per session, per process),
`userMessageID`, `agent`, `providerID`, `modelID`, `params`, `system`,
`messages`, `systemCapturedAt`, `messagesCapturedAt`, `lastMessageID`.
`system` or `messages` is `null` when that hook did not fire for the call.

`type: "tool"` — `toolID`, `hash`, `description`, `parameters`.

## Runtime parity

- Web and Desktop managed OpenCode: injected when the flag is set.
- External OpenCode (`OPENCODE_HOST` or skip-start) and VS Code's separate
  OpenCode lifecycle: not injected, because OpenChamber does not control that
  process environment.
