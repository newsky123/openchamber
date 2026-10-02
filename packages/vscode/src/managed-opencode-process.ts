import { sanitizeManagedOpenCodeEnv, waitForManagedOpenCodeHandshake } from '../../web/server/lib/opencode/managed-auth.js';
import { spawnOwnedProcess } from './owned-process';
import { registerManagedProcess, unregisterManagedProcess } from './opencodeProcessRegistry';

export function spawnManagedOpenCodeProcess(
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; port: number; timeoutMs: number; signal: AbortSignal; sourceBinary: string },
) {
  options.signal.throwIfAborted();
  // Sanitize at the final spawn boundary, including callers with merged shell env.
  const owned = spawnOwnedProcess(binary, args, { cwd: options.cwd, env: sanitizeManagedOpenCodeEnv(options.env) });
  const registration = registerManagedProcess({
    pid: owned.child.pid, ownerPid: process.pid, port: options.port, binary: options.sourceBinary, runtime: 'vscode',
  });
  const startup = new AbortController();
  let url: string | null = null;
  let password: string | null = null;
  let closing: Promise<void> | null = null;
  const clearConnection = () => {
    url = null;
    password = null;
  };
  const close = () => {
    clearConnection();
    startup.abort();
    if (!closing) closing = (async () => {
      await registration;
      await owned.terminate();
      await unregisterManagedProcess(owned.child.pid);
    })();
    return closing;
  };
  const onAbort = () => { void close().catch(() => {}); };
  options.signal.addEventListener('abort', onAbort, { once: true });
  const onExit = () => {
    clearConnection();
    // Let the handshake reader classify an early process failure before cleanup.
    queueMicrotask(onAbort);
  };
  owned.child.once('exit', onExit);
  owned.child.once('error', onExit);
  const closed = owned.closed.then(async (exit) => {
    clearConnection();
    options.signal.removeEventListener('abort', onAbort);
    await close();
    return exit;
  });
  const ready = waitForManagedOpenCodeHandshake(owned.child, {
    hostname: '127.0.0.1', port: options.port, timeoutMs: options.timeoutMs, signal: startup.signal,
    requireCompiledPluginsOnly: true, agentToolsBootstrap: 0,
  }).then((connection) => {
    startup.signal.throwIfAborted();
    url = connection.url;
    password = connection.password;
  }).catch(async (error) => {
    await close();
    throw error;
  });
  if (options.signal.aborted) onAbort();
  return {
    get url() { return url; },
    getAuthHeaders() {
      if (!password) throw new Error('Managed OpenCode authentication is not ready');
      return { Authorization: `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}` };
    },
    ready, closed, close,
  };
}
