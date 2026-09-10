import { pathToFileURL } from 'node:url';
import { appendManagedPlugin } from '../opencode/managed-plugin-config.js';

/**
 * Opt-in capture of what OpenCode actually sends to the model.
 *
 * OpenCode assembles a request from parts no single API exposes: the system
 * prompt is built per call, the message list is transformed on the way out,
 * and tool schemas are rewritten per model. The session record on disk holds
 * none of it, so "why did the model not call this tool" cannot be answered
 * after the fact. This plugin sits on the hooks that carry those parts and
 * appends them to a local JSONL file.
 *
 * It must be the LAST managed plugin appended to `OPENCODE_CONFIG_CONTENT`.
 * `Plugin.trigger` runs every plugin's hook in load order over one shared
 * mutable output, so a hook that runs before another plugin records a value
 * that plugin is about to change. Running last is what makes the captured
 * system prompt the one that goes on the wire.
 *
 * Off unless `OPENCHAMBER_PROMPT_TELEMETRY` is set: what it writes is the
 * user's source code, file paths, and conversation, in the clear.
 */

const REDACTED = '[redacted]';
// Provider options are merged from the provider config block, which is where a
// custom OpenAI-compatible provider keeps its credentials.
const SECRET_KEY_PATTERN = /(^|[_-])(api[_-]?key|key|token|secret|password|authorization|credential)([_-]|$)/i;

const createPluginSource = (outputDirectory) => String.raw`
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"

const OUTPUT_DIRECTORY = ${JSON.stringify(outputDirectory)}
const SCHEMA_VERSION = 1
const REDACTED = ${JSON.stringify(REDACTED)}
const SECRET_KEY_PATTERN = ${SECRET_KEY_PATTERN.toString()}

const redact = (value, depth = 0) => {
  if (depth > 6 || value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1)
  }
  return out
}

const sessionOf = (messages) => {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const id = messages[index]?.info?.sessionID
    if (typeof id === "string" && id) return id
  }
  return null
}

const lastMessageId = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return null
  return messages[messages.length - 1]?.info?.id ?? null
}

export const OpenChamberPromptTelemetryPlugin = async ({ directory }) => {
  // The three hooks that carry a request fire separately. Each keeps its
  // latest snapshot per session; chat.params is the commit point because it is
  // the last hook that still knows the session, agent, and model.
  const messagesBySession = new Map()
  const systemBySession = new Map()
  // Tool schemas are rewritten per model but rarely change between turns, so
  // only unseen (tool, schema) pairs are written.
  const toolHashes = new Map()
  const sequenceBySession = new Map()
  let queue = Promise.resolve()

  const write = (record) => {
    // Not awaited by the hooks: an LLM call must not wait on disk. The chain
    // keeps appends ordered; a hard kill can lose the records still on it.
    queue = queue
      .then(async () => {
        const day = new Date(record.time).toISOString().slice(0, 10)
        const file = path.join(OUTPUT_DIRECTORY, day + ".jsonl")
        await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true, mode: 0o700 })
        await fs.appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 })
      })
      .catch(() => {
        // A telemetry write must never surface as a failed turn: Plugin.trigger
        // treats a rejected hook as a defect and kills the request.
      })
  }

  const guard = (fn) => async (input, output) => {
    try {
      await fn(input, output)
    } catch {}
  }

  return {
    "experimental.chat.messages.transform": guard(async (_input, output) => {
      const sessionID = sessionOf(output?.messages)
      if (!sessionID) return
      messagesBySession.set(sessionID, { at: Date.now(), messages: output.messages })
    }),

    "experimental.chat.system.transform": guard(async (input, output) => {
      if (!input?.sessionID || !Array.isArray(output?.system)) return
      systemBySession.set(input.sessionID, { at: Date.now(), system: [...output.system] })
    }),

    "chat.params": guard(async (input, output) => {
      const sessionID = input?.sessionID
      if (!sessionID) return
      const messages = messagesBySession.get(sessionID)
      const system = systemBySession.get(sessionID)
      const sequence = (sequenceBySession.get(sessionID) ?? 0) + 1
      sequenceBySession.set(sessionID, sequence)

      write({
        schemaVersion: SCHEMA_VERSION,
        type: "request",
        time: Date.now(),
        directory,
        sessionID,
        sequence,
        userMessageID: input.message?.id ?? null,
        agent: input.agent ?? null,
        providerID: input.provider?.id ?? input.model?.providerID ?? null,
        modelID: input.model?.id ?? null,
        params: {
          temperature: output?.temperature ?? null,
          topP: output?.topP ?? null,
          topK: output?.topK ?? null,
          maxOutputTokens: output?.maxOutputTokens ?? null,
          options: redact(output?.options ?? {}),
        },
        system: system?.system ?? null,
        systemCapturedAt: system?.at ?? null,
        messages: messages?.messages ?? null,
        messagesCapturedAt: messages?.at ?? null,
        lastMessageID: lastMessageId(messages?.messages),
      })
    }),

    // Tool definitions carry no session, so they are their own record rather
    // than a field on the request they belong to.
    "tool.definition": guard(async (input, output) => {
      const toolID = input?.toolID
      if (!toolID) return
      const description = output?.description ?? ""
      const parameters = output?.parameters ?? null
      const hash = crypto
        .createHash("sha256")
        .update(description + " " + JSON.stringify(parameters))
        .digest("hex")
      if (toolHashes.get(toolID) === hash) return
      toolHashes.set(toolID, hash)

      write({
        schemaVersion: SCHEMA_VERSION,
        type: "tool",
        time: Date.now(),
        directory,
        toolID,
        hash,
        description,
        parameters,
      })
    }),

    dispose: async () => {
      await queue
    },
  }
}
`;

export const createPromptTelemetryRuntime = ({ fsPromises, path, dataDir }) => {
  const pluginDirectory = path.join(dataDir, 'prompt-telemetry');
  const pluginPath = path.join(pluginDirectory, 'openchamber-prompt-telemetry-plugin.js');
  const outputDirectory = path.join(pluginDirectory, 'records');

  const prepareManagedOpenCodeEnv = async (rawConfig) => {
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginPath, createPluginSource(outputDirectory), { mode: 0o600 });
    return {
      OPENCODE_CONFIG_CONTENT: appendManagedPlugin(rawConfig, pathToFileURL(pluginPath).href, 'prompt telemetry'),
    };
  };

  return { prepareManagedOpenCodeEnv, outputDirectory };
};
