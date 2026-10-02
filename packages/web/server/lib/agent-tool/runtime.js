import { z } from 'zod';
import {
  OPENCHAMBER_AGENT_TOOL_ACTIONS,
  OPENCHAMBER_MEMORY_ACTIONS,
  OPENCHAMBER_NOTIFY_ACTIONS,
  resolveAgentToolAction,
  OPENCHAMBER_WEB_ACTIONS,
} from '../openchamber-control/actions.js';
import { AGENT_TOOL_DEFINITIONS, createAgentToolCatalog, isAgentToolEnabled, agentToolSettingsSchema } from './catalog.js';

const TOOL_SCHEMA_VERSION = 1;
// Everything either managed tool may ask for; the agent allowlist stays
// narrower than the full control surface.
const ACTIONS = new Set([
  ...OPENCHAMBER_AGENT_TOOL_ACTIONS,
  ...OPENCHAMBER_WEB_ACTIONS,
  ...OPENCHAMBER_MEMORY_ACTIONS,
  ...OPENCHAMBER_NOTIFY_ACTIONS,
]);
const textSchema = z.string().trim().min(1);
const requestSchema = z.object({
  tool: textSchema,
  sessionID: textSchema.max(200),
  input: z.record(z.string(), z.unknown()),
}).strict();
const asNonEmptyString = (value) => {
  const parsed = textSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const createResult = ({ ok, action, data, error, exitCode }) => {
  const result = { schemaVersion: TOOL_SCHEMA_VERSION, ok, action: action || 'unknown' };
  if (data !== undefined) result.data = data;
  if (error) result.error = error;
  if (Number.isInteger(exitCode)) result.exitCode = exitCode;
  return result;
};

// Node reports an IPv4 peer on a dual-stack socket as `::ffff:<ipv4>`.
const normalizeAddress = (value) => {
  const address = (asNonEmptyString(value) || '').toLowerCase();
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
};

const isLoopbackAddress = (value) => {
  const address = normalizeAddress(value);
  return address === '127.0.0.1' || address === '::1';
};

const WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::']);

// A wildcard listener answers on loopback. A listener bound to one concrete
// address answers only there, so that address is the only way back in.
const resolveConcreteBoundAddress = (value) => {
  const address = normalizeAddress(value);
  return address && !WILDCARD_ADDRESSES.has(address) ? address : null;
};

export const createAgentToolRuntime = (dependencies) => {
  const {
    crypto,
    getActivePort,
    getActiveHost = () => null,
    executeAction,
    resolveSessionDirectory,
    readSettings,
    isAgentMemoryAvailable,
    credentialState = { token: null, authority: null },
  } = dependencies;
  const getConcreteBoundAddress = () => resolveConcreteBoundAddress(getActiveHost());

  // The only serialization of this credential is the bounded private startup
  // pipe. It never becomes an environment variable or a config-file property.
  const createBootstrap = () => {
    const port = getActivePort();
    if (!Number.isInteger(port) || port <= 0) throw new Error('OpenChamber listener is unavailable for the compiled agent tools');
    for (const controllers of inflightBySession.values()) {
      for (const controller of controllers) controller.abort();
    }
    const token = crypto.randomBytes(32).toString('base64url');
    credentialState.token = token;
    const address = getConcreteBoundAddress() || '127.0.0.1';
    const host = address.includes(':') ? `[${address}]` : address;
    credentialState.authority = `${host}:${port}`;
    return {
      payload: { version: 1, url: `http://${host}:${port}/api/openchamber/agent-tool`, token, catalog: createAgentToolCatalog() },
      revoke: () => { if (credentialState.token === token) revoke(); },
    };
  };
  const revoke = () => {
    credentialState.token = null;
    credentialState.authority = null;
    for (const controllers of inflightBySession.values()) {
      for (const controller of controllers) controller.abort();
    }
  };

  // The managed child runs on this machine. Reaching a listener bound to one
  // concrete address makes the OS source the connection from that same address,
  // so it stands in for loopback there; any other machine arrives as itself.
  const isSameMachineAddress = (value) => {
    if (isLoopbackAddress(value)) return true;
    const boundAddress = getConcreteBoundAddress();
    return boundAddress !== null && normalizeAddress(value) === boundAddress;
  };

  const authorize = (req) => {
    if (!credentialState.token || !isSameMachineAddress(req.socket?.remoteAddress)
      || req.headers?.origin !== undefined || req.headers?.host !== credentialState.authority) return false;
    const header = asNonEmptyString(req.headers?.authorization);
    if (!header?.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(credentialState.token);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };

  const execute = async (rawPayload, options = {}) => {
    const parsed = requestSchema.safeParse(rawPayload);
    if (!parsed.success) {
      return createResult({ ok: false, error: { message: 'Invalid compiled agent tool request', kind: 'usage' } });
    }
    const payload = parsed.data;
    const requested = asNonEmptyString(payload.input.action);
    const tool = AGENT_TOOL_DEFINITIONS.find(({ name }) => name === payload.tool);
    let rawSettings;
    try { rawSettings = await readSettings(); } catch { rawSettings = null; }
    const settings = agentToolSettingsSchema.safeParse(rawSettings);
    if (!tool || !settings.success || !isAgentToolEnabled(tool, settings.data, isAgentMemoryAvailable())) {
      return createResult({ ok: false, action: requested, error: { message: 'OpenChamber tool is unavailable or disabled', kind: 'usage' } });
    }
    if (Object.keys(payload.input).some((key) => key !== 'action' && !Object.hasOwn(tool.parameters, key))) {
      return createResult({ ok: false, action: requested, error: { message: 'Unsupported tool parameter', kind: 'usage' } });
    }
    // Resolved against the calling tool's own actions: models drop the
    // namespace that the tool's name already implies, and answering "read" with
    // a bare "unsupported" leaves them to guess a second wrong name.
    const resolution = resolveAgentToolAction(requested, asNonEmptyString(payload.tool));
    if (resolution.error) {
      return createResult({ ok: false, action: requested, error: { message: resolution.error, kind: 'usage' } });
    }
    const action = resolution.action;
    if (!ACTIONS.has(action)) {
      return createResult({ ok: false, action, error: { message: `Unsupported OpenChamber action: ${action}`, kind: 'usage' } });
    }
    const sessionID = asNonEmptyString(payload.sessionID);
    if (!sessionID) return createResult({ ok: false, action, error: { message: 'Caller session is required', kind: 'usage' } });
    const contextDirectory = await Promise.resolve(resolveSessionDirectory(sessionID)).catch(() => null);
    if (!asNonEmptyString(contextDirectory)) {
      return createResult({ ok: false, action, error: { message: 'Caller session directory is unavailable', kind: 'runtime' } });
    }
    try {
      // The calling session scopes browser actions to that session's page.
      const contextSessionId = sessionID;
      options.signal?.throwIfAborted();
      const data = await executeAction(action, { ...payload.input, action }, contextDirectory, { ...options, contextSessionId });
      return createResult({ ok: true, action, data });
    } catch (error) {
      const failure = createResult({
        ok: false,
        action,
        error: {
          message: (error instanceof Error ? error.message : String(error)).replaceAll(credentialState.token ?? '\0', '[redacted]'),
          kind: Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 499 ? 'usage' : 'runtime',
        },
      });
      if (error?.partial === true) failure.data = {
        partial: true, partialAction: error.partialAction, sessionId: error.sessionId, directory: error.directory,
      };
      return failure;
    }
  };

  // In-flight actions per session. The plugin forwards OpenCode's abort
  // signal (2.0.12+), which closes its request and aborts the action here.
  // Before that release the request stayed open after the user cancelled the
  // turn, so the server also listens for the cancel on the event stream
  // (`session.idle` with `aborted: true`) and aborts the actions itself.
  const inflightBySession = credentialState.inflightBySession ??= new Map();
  const trackInflight = (sessionID, controller) => {
    if (!sessionID) return () => {};
    const set = inflightBySession.get(sessionID) ?? new Set();
    set.add(controller);
    inflightBySession.set(sessionID, set);
    return () => {
      set.delete(controller);
      if (set.size === 0) inflightBySession.delete(sessionID);
    };
  };
  const abortSession = (sessionID) => {
    const set = inflightBySession.get(asNonEmptyString(sessionID));
    if (!set) return 0;
    for (const controller of set) controller.abort();
    return set.size;
  };

  const registerRoutes = (app, express) => {
    app.post('/api/openchamber/agent-tool', express.json({ limit: '1mb' }), async (req, res) => {
      if (!authorize(req)) return res.status(401).json({ error: 'Unauthorized' });
      const controller = new AbortController();
      const abortOnDisconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once('aborted', abortOnDisconnect);
      res.once('close', abortOnDisconnect);
      const untrack = trackInflight(asNonEmptyString(req.body?.sessionID), controller);
      try {
        return res.json(await execute(req.body, { signal: controller.signal }));
      } catch (error) {
        return res.json(createResult({
          ok: false,
          action: req.body?.input?.action,
          error: { message: (error instanceof Error ? error.message : String(error)).replaceAll(credentialState.token ?? '\0', '[redacted]'), kind: 'runtime' },
        }));
      } finally {
        untrack();
        req.off('aborted', abortOnDisconnect);
        res.off('close', abortOnDisconnect);
      }
    });
  };

  return {
    createBootstrap,
    revoke,
    registerRoutes,
    execute,
    abortSession,
  };
};
