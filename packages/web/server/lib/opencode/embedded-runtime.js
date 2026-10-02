import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripAppImageArgv0Leak, stripAppImageLauncherEnv } from '../inherited-env.js';

// A transport identity only: no listener is opened at this address.
export const EMBEDDED_OPENCODE_ORIGIN = 'http://opencode.local';
export const EMBEDDED_OPENCODE_VERSION = '2.0.21';
let activeHost = null;
let starting = false;

export function fetchOpenCode(input, init) {
  const url = URL.parse(input instanceof Request ? input.url : input);
  if (url?.origin !== EMBEDDED_OPENCODE_ORIGIN) return globalThis.fetch(input, init);
  if (!activeHost) return Promise.reject(new Error('Embedded OpenCode is unavailable'));
  return activeHost.fetch(input, init);
}

// Use the official embedded router assembly used by @opencode/sdk, exposing
// its transport so existing API routes and generated clients retain fidelity.
export async function createEmbeddedOpenCode({ env = process.env, databasePath, directory = process.cwd(), options = {} } = {}) {
  if (activeHost || starting) throw new Error('An embedded OpenCode host is already running');
  env = stripAppImageLauncherEnv(stripAppImageArgv0Leak({ ...env }));
  if (databasePath === ':memory:' || env.OPENCODE_DB === ':memory:') throw new Error('Embedded OpenCode requires a persistent database');
  const dataDir = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
  const filename = path.resolve(dataDir, databasePath ?? (env.OPENCODE_DB || 'opencode.db'));
  const defaultDirectory = path.resolve(directory);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  starting = true;
  // Provider adapters and plugins inherit managed callback and shell variables.
  // Config options are passed directly; changing the host's config env would
  // incorrectly mark OpenChamber's managed config as a user-owned override.
  const previousEnv = new Map();
  // Sanitizers remove launcher-only variables rather than setting them to an
  // empty value. Propagate those removals to in-process tools as well, and
  // restore host values when this engine releases ownership.
  for (const key of ['ARGV0', 'PATH', 'LD_LIBRARY_PATH', 'GSETTINGS_SCHEMA_DIR', 'XDG_DATA_DIRS']) {
    if (key !== 'ARGV0' && !env.APPDIR) continue;
    if (env[key] !== undefined || process.env[key] === undefined) continue;
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || ['HOME', 'home', 'CODEX_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT'].includes(key) || process.env[key] === value) continue;
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  const restoreEnv = () => {
    for (const [key, value] of previousEnv) {
      if (process.env[key] !== env[key]) continue;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let runtime;
  const disabled = (key) => /^(?:true|1)$/iu.test(env[key] ?? '');
  try {
    if (!env.OPENCODE_PTY_BIN) {
      const { binaryPath } = await import('@opencode-ai/pty');
      if (binaryPath) {
        const executable = process.versions.electron ? binaryPath.replace(/\.asar([/\\])/u, '.asar.unpacked$1') : binaryPath;
        previousEnv.set('OPENCODE_PTY_BIN', process.env.OPENCODE_PTY_BIN);
        env.OPENCODE_PTY_BIN = executable;
        process.env.OPENCODE_PTY_BIN = executable;
      }
    }
    const [{ createEmbeddedRoutes }, { Context, Layer, ManagedRuntime, Schema }, { HttpEffect, HttpRouter, HttpServer }, { SessionRestart }] = await Promise.all([
      import('@opencode/server/routes'), import('effect'), import('effect/unstable/http'),
      import('@opencode/core/session/execution/restart'),
    ]);
    const isRequestObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
    runtime = ManagedRuntime.make(createEmbeddedRoutes({
      app: { name: 'opencode', version: EMBEDDED_OPENCODE_VERSION, channel: 'latest' },
      config: { file: env.OPENCODE_CONFIG, content: env.OPENCODE_CONFIG_CONTENT, directory: env.OPENCODE_CONFIG_DIR, project: !disabled('OPENCODE_DISABLE_PROJECT_CONFIG') },
      models: { url: env.OPENCODE_MODELS_URL, file: env.OPENCODE_MODELS_PATH, fetch: !disabled('OPENCODE_DISABLE_MODELS_FETCH') },
      windows: { gitbash: env.OPENCODE_GIT_BASH_PATH },
      fs: {
        filewatcher: !disabled('OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER'),
        fff: env.OPENCODE_DISABLE_FFF === undefined ? process.platform !== 'win32' : !disabled('OPENCODE_DISABLE_FFF'),
      },
      ...options,
      database: { path: filename },
      events: { persist: true },
    }).pipe(Layer.provide(HttpServer.layerServices)));
    const services = await runtime.runPromise(runtime.contextEffect);
    runtime.runFork(Context.get(services, SessionRestart.Service).resumeSuspendedSessions);
    const handler = HttpEffect.toWebHandlerWith(services)(Context.get(services, HttpRouter.HttpRouter).asHttpEffect());
    const shutdown = new AbortController();
    const requests = new Set();
    let closePromise = null;
    const host = {
      url: EMBEDDED_OPENCODE_ORIGIN,
      pid: null,
      get exitCode() { return closePromise ? 0 : null; },
      async fetch(input, init) {
        if (closePromise) throw new Error('Embedded OpenCode is closed');
        const entries = init?.headers instanceof Headers ? [...init.headers]
          : Array.isArray(init?.headers) ? init.headers : Object.entries(init?.headers ?? {});
        const headers = entries.map(([key, value]) => [key,
          key.toLowerCase() === 'x-opencode-directory' && /[^\p{ASCII}]/u.test(value) ? encodeURIComponent(value) : value]);
        const requestInit = { ...init };
        if (init?.headers) requestInit.headers = headers;
        let source = new Request(input, requestInit);
        source.signal.throwIfAborted();
        const signal = AbortSignal.any([source.signal, shutdown.signal]);
        const requestHeaders = new Headers(source.headers);
        if (!requestHeaders.has('x-opencode-directory')) requestHeaders.set('x-opencode-directory', encodeURIComponent(defaultDirectory));
        source = new Request(source, { headers: requestHeaders, signal });
        // These official routes default the payload location to cwd, bypassing
        // the header. Preserve the old neutral cwd without changing host cwd.
        const pathname = new URL(source.url).pathname;
        if (source.method === 'POST' && ['/api/session', '/api/session/import'].includes(pathname) && source.headers.get('content-type')?.includes('application/json')) {
          let body = await source.text();
          try {
            const payload = JSON.parse(body);
            if (isRequestObject(payload) && payload.location == null) {
              payload.location = { directory: defaultDirectory };
              body = JSON.stringify(payload);
            }
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
          requestHeaders.delete('content-length');
          source = new Request(source, { headers: requestHeaders, body });
        }
        signal.throwIfAborted();
        const lifetime = Promise.withResolvers();
        requests.add(lifetime.promise);
        const finish = () => { requests.delete(lifetime.promise); lifetime.resolve(); };
        const handled = handler(new Request(source, { signal }));
        return new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          handled.then((response) => {
            signal.removeEventListener('abort', abort);
            resolve(trackResponse(response, signal, finish));
          }, (error) => {
            signal.removeEventListener('abort', abort); finish(); reject(error);
          });
        });
      },
      close() {
        if (closePromise) return closePromise;
        shutdown.abort(new Error('Embedded OpenCode is closed'));
        closePromise = Promise.allSettled(requests).then(() => runtime.dispose()).finally(() => {
          if (activeHost === host) activeHost = null;
          restoreEnv();
        });
        return closePromise;
      },
    };
    activeHost = host;
    return host;
  } catch (error) {
    await runtime?.dispose(); restoreEnv(); throw error;
  } finally { starting = false; }
}

// A request owns its stream until consumption, cancellation or shutdown.
function trackResponse(response, signal, finish) {
  if (!response.body) { finish(); return response; }
  const reader = response.body.getReader();
  let done = false;
  let abort;
  const complete = () => {
    if (done) return false;
    done = true; signal.removeEventListener('abort', abort); return true;
  };
  const body = new ReadableStream({
    start(controller) {
      abort = () => {
        if (!complete()) return;
        controller.error(signal.reason);
        reader.cancel(signal.reason).then(finish, finish);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (done) return;
        if (!next.done) return controller.enqueue(next.value);
        if (!complete()) return;
        controller.close(); finish();
      } catch (error) {
        if (!complete()) return;
        controller.error(error); finish();
      }
    },
    async cancel(reason) {
      if (!complete()) return;
      try { await reader.cancel(reason); } finally { finish(); }
    },
  });
  return new Response(body, response);
}
