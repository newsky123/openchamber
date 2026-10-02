import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const recordStartupPerformanceMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
  // `managed-process-registry.js` (imported transitively via lifecycle.js)
  // calls `promisify(execFile)` at module load, so the mock must expose a
  // function here. Lifecycle tests don't exercise the reaper path, so a plain
  // stub is enough; the registry's best-effort writes are no-ops on errors.
  execFile: vi.fn(),
}));
vi.mock('./startup-performance.js', () => ({
  recordStartupPerformance: recordStartupPerformanceMock,
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;
const compiledPolicy = Object.freeze({ version: 1, compiledPluginsOnly: true, agentToolsBootstrap: 0 });

afterEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  recordStartupPerformanceMock.mockReset();
  globalThis.fetch = originalFetch;
  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }

  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.resume = vi.fn();
  child.stderr.resume = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  return child;
};

const createRuntime = (overrides = {}, stateOverrides = {}, envOverrides = {}) => {
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    lastOpenCodeHealthFailure: null,
    lastManagedOpenCodeProcess: null,
    lastOpenCodeRestartDiagnostics: null,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    ...stateOverrides,
  };

  const runtime = createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
      ...envOverrides,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    applyOpencodeBinaryFromSettings: vi.fn(async () => null),
    checkOpenCodeBinary: async () => '2.0.19',
  ensureOpencodeCliEnv: vi.fn(),
    setManagedOpenCodePassword: vi.fn(),
    resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
    setOpenCodePort: vi.fn((port) => {
      state.openCodePort = port;
    }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    clearResolvedOpenCodeBinary: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    // Never let a test touch the real `~/.local/share/opencode/opencode.db`.
    topUpV1SessionMigration: vi.fn(() => ({ status: 'skipped', missing: 0, revisited: 0, reason: 'no-database' })),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
      PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
      SHELL_ONLY: 'yes',
      OPENCODE_PASSWORD: 'shell-password',
      OPENCODE_SERVER_PASSWORD: 'shell-password',
    })),
    ...overrides,
  });
  runtime.testState = state;
  return runtime;
};

describe('OpenCode lifecycle', () => {
  it('filters approved loader controls from process, shell, and managed env after merges and during preflight', async () => {
    const controls = ['NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', 'BUN_BE_BUN', 'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES'];
    const originals = Object.fromEntries(controls.map((key) => [key, process.env[key]]));
    const shell = Object.fromEntries(controls.map((key) => [key.toLowerCase(), 'shell-loader']));
    const managed = Object.fromEntries(controls.map((key) => [key[0] + key.slice(1).toLowerCase(), 'managed-loader']));
    const check = vi.fn(async () => '2.0.21');
    const replacement = createMockChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => replacement.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
      return replacement;
    });
    let server;
    try {
      for (const key of controls) process.env[key] = 'process-loader';
      const runtime = createRuntime({
        checkOpenCodeBinary: check,
        getManagedOpenCodeShellEnvSnapshot: () => ({ ...shell, SHELL_KEEP: 'shell' }),
        getManagedOpenCodeEnv: async () => ({ ...managed, MANAGED_KEEP: 'managed' }),
      });
      server = await runtime.startOpenCode();
      const preflightEnv = check.mock.calls[0][1].env;
      const launchEnv = spawnMock.mock.calls[0][2].env;
      for (const environment of [preflightEnv, launchEnv]) {
        expect(Object.keys(environment).some((key) => controls.includes(key.toUpperCase()))).toBe(false);
        expect(environment.SHELL_KEEP).toBe('shell');
      }
      expect(launchEnv.MANAGED_KEEP).toBe('managed');
      expect(runtime.getManagedOpenCodeProcessEnv()).toBe(launchEnv);
      for (const key of controls) expect(process.env[key]).toBe('process-loader');
      expect(shell.node_options).toBe('shell-loader');
      expect(managed.Node_options).toBe('managed-loader');
    } finally {
      await server?.close();
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('leaves explicit external connections outside loader filtering and managed policy checks', async () => {
    const original = process.env.NODE_OPTIONS;
    const password = vi.fn();
    const managedEnv = vi.fn();
    const preflight = vi.fn();
    process.env.NODE_OPTIONS = '--max-old-space-size=2048';
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: '2.0.21', pid: 1, urls: [], paths: { tmp: '/tmp' } }) }));
    try {
      const runtime = createRuntime({
        setManagedOpenCodePassword: password, getManagedOpenCodeEnv: managedEnv,
        checkOpenCodeBinary: preflight, reapManagedOrphanedProcesses: async () => ({ reaped: 0 }),
      }, { isExternalOpenCode: true, isOpenCodeReady: true }, {
        ENV_SKIP_OPENCODE_START: true, ENV_EFFECTIVE_PORT: 45678,
      });
      await runtime.bootstrapOpenCodeAtStartup();
      expect(password).not.toHaveBeenCalled();
      expect(managedEnv).not.toHaveBeenCalled();
      expect(preflight).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(process.env.NODE_OPTIONS).toBe('--max-old-space-size=2048');
      expect(runtime.testState.isOpenCodeReady).toBe(true);
    } finally {
      if (original === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = original;
    }
  });

  for (const policy of [undefined, { version: 1, compiledPluginsOnly: false, agentToolsBootstrap: 0 }, { version: 2, compiledPluginsOnly: true, agentToolsBootstrap: 0 }]) {
    it(`retires an unverified healthy HMR process before health or warmup: ${JSON.stringify(policy)}`, async () => {
      const close = vi.fn(async () => {});
      const legacy = { pid: null, managedStartupCapabilities: policy, close };
      const password = vi.fn();
      const replacement = createMockChild();
      spawnMock.mockImplementation(() => {
        expect(close).toHaveBeenCalledOnce();
        queueMicrotask(() => replacement.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
        return replacement;
      });
      const runtime = createRuntime({
        setManagedOpenCodePassword: password,
        reapManagedOrphanedProcesses: async () => {
          expect(runtime.testState.isOpenCodeReady).toBe(false);
          expect(password).toHaveBeenLastCalledWith(null);
          return { reaped: 0 };
        },
        getWarmupDirectories: async () => ['/tmp/project'],
      }, { openCodeProcess: legacy, openCodePort: 45678, isOpenCodeReady: true }, { ENV_EFFECTIVE_PORT: null });
      // Constructor revokes old readiness before any asynchronous bootstrap.
      expect(runtime.testState.isOpenCodeReady).toBe(false);
      expect(password).toHaveBeenLastCalledWith(null);
      globalThis.fetch = vi.fn(async () => {
        expect(runtime.testState.openCodeProcess).not.toBe(legacy);
        expect(runtime.testState.openCodeProcess.managedStartupCapabilities).toEqual(compiledPolicy);
        return { ok: true, json: async () => ({ version: '2.0.21', pid: 1, urls: [], paths: { tmp: '/tmp' } }) };
      });
      await runtime.bootstrapOpenCodeAtStartup();
      expect(close).toHaveBeenCalledOnce();
      expect(spawnMock).toHaveBeenCalledOnce();
      expect(runtime.testState.isOpenCodeReady).toBe(true);
      await runtime.testState.openCodeProcess.close();
    });
  }

  it('reuses a proven HMR handle and preserves its credential without spawning', async () => {
    const close = vi.fn(async () => {});
    const proven = { pid: null, managedStartupCapabilities: compiledPolicy, close };
    const password = vi.fn();
    const sharedState = createRuntime().testState;
    Object.assign(sharedState, { openCodeProcess: proven, openCodePort: 45678, isOpenCodeReady: true });
    const runtime = createRuntime({ state: sharedState, setManagedOpenCodePassword: password, reapManagedOrphanedProcesses: async () => ({ reaped: 0 }) });
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: '2.0.21', pid: 1, urls: [], paths: { tmp: '/tmp' } }) }));
    expect(await runtime.startOpenCode()).toBe(proven);
    await runtime.bootstrapOpenCodeAtStartup();
    expect(sharedState.openCodeProcess).toBe(proven);
    expect(sharedState.isOpenCodeReady).toBe(true);
    expect(password).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  for (const pendingKey of ['currentStartPromise', 'currentRestartPromise']) {
    it(`revalidates a legacy handle after inherited ${pendingKey} resolves`, async () => {
      const close = vi.fn(async () => {});
      const legacy = { pid: null, close };
      const sharedState = createRuntime().testState;
      let release;
      sharedState[pendingKey] = new Promise((resolve) => { release = resolve; });
      const runtime = createRuntime({ state: sharedState });
      spawnMock.mockImplementation(() => {
        expect(close).toHaveBeenCalledOnce();
        const replacement = createMockChild();
        queueMicrotask(() => replacement.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
        return replacement;
      });
      const starting = runtime.startOpenCode();
      Object.assign(sharedState, { openCodeProcess: legacy, openCodePort: 45678, isOpenCodeReady: true });
      release(legacy);
      const server = await starting;
      expect(server).not.toBe(legacy);
      expect(server.managedStartupCapabilities).toEqual(compiledPolicy);
      expect(close).toHaveBeenCalledOnce();
      await server.close();
    });
  }

  for (const pendingKey of ['currentStartPromise', 'currentRestartPromise']) {
    for (const entry of ['startOpenCode', 'bootstrapOpenCodeAtStartup']) {
      it(`retires an unknown child when ${entry} joins rejected ${pendingKey}`, async () => {
        let reject;
        let finishClose;
        const closing = new Promise((resolve) => { finishClose = resolve; });
        const close = vi.fn(() => closing);
        const legacy = { pid: null, close };
        const sharedState = createRuntime().testState;
        Object.assign(sharedState, { openCodeProcess: legacy, openCodePort: 45678, isOpenCodeReady: true });
        sharedState[pendingKey] = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
        const warmup = vi.fn(async () => ['/tmp/must-not-open']);
        const runtime = createRuntime({ state: sharedState, getWarmupDirectories: warmup });
        globalThis.fetch = vi.fn();
        let settled = false;
        const waiting = runtime[entry]().then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
        reject(new Error('PRIVATE-INHERITED-FAILURE'));
        await expect.poll(() => close.mock.calls.length).toBe(1);
        expect(settled).toBe(false);
        expect(sharedState.openCodeProcess).toBe(legacy);
        finishClose();
        const error = await waiting;
        if (entry === 'startOpenCode') expect(error.message).toContain('inherited OpenCode startup operation failed');
        else expect(sharedState.lastOpenCodeError).toContain('inherited OpenCode startup operation failed');
        expect(String(error?.message || sharedState.lastOpenCodeError)).not.toContain('PRIVATE-INHERITED-FAILURE');
        expect(sharedState.openCodeProcess).toBe(null);
        expect(sharedState[pendingKey]).toBe(null);
        expect(sharedState.isOpenCodeReady).toBe(false);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(warmup).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
        // Settled legacy promises cannot trap a later explicit restart in a loop.
        spawnMock.mockImplementation(() => {
          expect(close).toHaveBeenCalledOnce();
          const replacement = createMockChild();
          queueMicrotask(() => replacement.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
          return replacement;
        });
        const server = await runtime.startOpenCode();
        expect(server.managedStartupCapabilities).toEqual(compiledPolicy);
        await server.close();
      });
    }
  }

  it('retains ownership and blocks startup if rejected-HMR cleanup cannot close its child', async () => {
    const close = vi.fn(async () => { throw new Error('PRIVATE-CLOSE-FAILURE'); });
    const legacy = { pid: null, close };
    let reject;
    const pending = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
    const runtime = createRuntime({}, { openCodeProcess: legacy, currentStartPromise: pending, isOpenCodeReady: true });
    const result = runtime.startOpenCode().catch((error) => error);
    reject(new Error('PRIVATE-INHERITED-FAILURE'));
    const error = await result;
    expect(error.message).toBe('The unverified managed OpenCode process could not be stopped. Managed startup remains blocked.');
    expect(runtime.testState.openCodeProcess).toBe(legacy);
    expect(runtime.testState.currentStartPromise).toBe(null);
    expect(runtime.testState.isOpenCodeReady).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  for (const external of [false, true]) {
    it(`preserves a ${external ? 'external' : 'proven'} replacement when an older operation rejects`, async () => {
      let reject;
      const pending = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
      const password = vi.fn();
      const runtime = createRuntime({ setManagedOpenCodePassword: password }, { currentRestartPromise: pending });
      const result = runtime.startOpenCode().catch((error) => error);
      const close = vi.fn(async () => {});
      const replacement = { pid: null, close, ...(external ? {} : { managedStartupCapabilities: compiledPolicy }) };
      Object.assign(runtime.testState, { openCodeProcess: replacement, isExternalOpenCode: external, isOpenCodeReady: true });
      reject(new Error('PRIVATE-INHERITED-FAILURE'));
      expect((await result).message).not.toContain('PRIVATE-INHERITED-FAILURE');
      expect(runtime.testState.openCodeProcess).toBe(replacement);
      expect(runtime.testState.isOpenCodeReady).toBe(true);
      expect(close).not.toHaveBeenCalled();
      expect(password).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    });
  }

  it('fails closed when an unverified handle has no owned close operation', async () => {
    const runtime = createRuntime({}, { openCodeProcess: { pid: null }, openCodePort: 45678, isOpenCodeReady: true });
    await expect(runtime.startOpenCode()).rejects.toThrow('no verified compiled-only');
    await expect(runtime.waitForOpenCodeReady()).rejects.toThrow('no verified compiled-only');
    expect(runtime.testState.isOpenCodeReady).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('honors shutdown from a reloaded HMR owner while the old startup is pending', async () => {
    const sharedState = createRuntime().testState;
    let releasePreflight;
    const preflight = new Promise((resolve) => { releasePreflight = resolve; });
    const oldRuntime = createRuntime({ state: sharedState, checkOpenCodeBinary: () => preflight });
    const starting = oldRuntime.startOpenCode();
    sharedState.isShuttingDown = true;
    releasePreflight('2.0.21');
    await expect(starting).rejects.toThrow('cancelled during shutdown');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(sharedState.currentStartPromise).toBe(null);
  });

  it('joins an old HMR module startup and reads the live process port before readiness', async () => {
    const sharedState = createRuntime().testState;
    let releasePreflight;
    const preflight = new Promise((resolve) => { releasePreflight = resolve; });
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: '2.0.21' }) }));
    const deps = {
      state: sharedState,
      setOpenCodePort: (port) => { sharedState.openCodePort = port; },
      reapManagedOrphanedProcesses: async () => ({ reaped: 0 }),
    };
    const oldRuntime = createRuntime({ ...deps, checkOpenCodeBinary: () => preflight });
    const starting = oldRuntime.startOpenCode();
    const reloadedRuntime = createRuntime(deps);
    const booting = reloadedRuntime.bootstrapOpenCodeAtStartup();
    releasePreflight('2.0.21');
    await Promise.all([starting, booting]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(sharedState.openCodePort).toBe(45678);
    expect(sharedState.isOpenCodeReady).toBe(true);
    expect(sharedState.lastOpenCodeError).toBe(null);
    await sharedState.openCodeProcess.close();
  });

  it('joins concurrent starts on the same runtime instead of spawning competing auth owners', async () => {
    const setManagedOpenCodePassword = vi.fn();
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
      return child;
    });
    const runtime = createRuntime({ setManagedOpenCodePassword });
    const handles = await Promise.all([runtime.startOpenCode(), runtime.startOpenCode(), runtime.startOpenCode()]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(handles[0]).toBe(handles[1]);
    expect(handles[1]).toBe(handles[2]);
    expect(setManagedOpenCodePassword.mock.calls.filter(([value]) => value !== null)).toHaveLength(1);
    await handles[0].close();
    expect(setManagedOpenCodePassword).toHaveBeenLastCalledWith(null);
  });

  it('serializes a restart behind an in-flight startup before adopting replacement auth', async () => {
    const children = [];
    const setManagedOpenCodePassword = vi.fn();
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      children.push(child);
      const password = children.length === 1 ? 'a'.repeat(43) : 'b'.repeat(43);
      queueMicrotask(() => child.stdout.emit('data', `openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password ${password}\n`));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const runtime = createRuntime({ setManagedOpenCodePassword });
    const started = runtime.startOpenCode();
    const restarting = runtime.restartOpenCode();
    const joining = runtime.startOpenCode();
    await Promise.all([started, restarting, joining]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(children[0].kill).toHaveBeenCalled();
    expect(runtime.testState.openCodeProcess).toBe(await joining);
    expect(setManagedOpenCodePassword).toHaveBeenLastCalledWith('b'.repeat(43));
    await runtime.testState.openCodeProcess.close();
  });

  it('never lets an obsolete process close revoke the authoritative replacement auth after HMR', async () => {
    const child = createMockChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
      return child;
    });
    const setManagedOpenCodePassword = vi.fn();
    const sharedState = createRuntime().testState;
    const runtime = createRuntime({ state: sharedState, setManagedOpenCodePassword });
    const oldServer = await runtime.startOpenCode();
    sharedState.openCodeProcess = { pid: 99999 };
    setManagedOpenCodePassword.mockClear();
    child.emit('exit', 0, null);
    await oldServer.close();
    expect(setManagedOpenCodePassword).not.toHaveBeenCalled();
    expect(sharedState.openCodeProcess.pid).toBe(99999);
  });

  it('uses the resolved binary directly on startup and managed restart without an env override', async () => {
    delete process.env.OPENCODE_BINARY;
    const binaries = ['/bundle one/opencode-cli/opencode', '/bundle two/opencode-cli/opencode'];
    const ensureOpencodeCliEnv = vi.fn()
      .mockReturnValueOnce(binaries[0])
      .mockReturnValueOnce(binaries[1]);
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    const runtime = createRuntime({ ensureOpencodeCliEnv });
    const firstServer = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = firstServer;
    try {
      await runtime.restartOpenCode();
      expect(firstServer.signalCode).toBe('SIGTERM');
      expect(spawnMock.mock.calls.map(([binary]) => binary)).toEqual(binaries);
      expect(runtime.testState.lastOpenCodeLaunchDiagnostics.sourceBinary).toBe(binaries[1]);
      expect(process.env.OPENCODE_BINARY).toBeUndefined();
      for (const [, , options] of spawnMock.mock.calls) {
        expect(options.env).not.toHaveProperty('OPENCODE_BINARY');
      }
      // Credential reads take variable keys from the environment the current process got.
      expect(runtime.getManagedOpenCodeProcessEnv()).toBe(spawnMock.mock.calls[1][2].env);
      expect(runtime.getManagedOpenCodeProcessEnv()).toMatchObject({ SHELL_ONLY: 'yes' });
    } finally {
      await runtime.testState.openCodeProcess.close();
    }
  });

  it('records an authoritative ready terminal event for external startup', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(recordStartupPerformanceMock).toHaveBeenCalledWith('opencode.bootstrap.ready', {
      totalDurationMs: expect.any(Number),
      outcome: 'ready',
    });
    expect(recordStartupPerformanceMock).not.toHaveBeenCalledWith(
      'opencode.bootstrap.error',
      expect.anything(),
    );
    const terminalEvents = recordStartupPerformanceMock.mock.calls.filter(([phase]) => (
      phase === 'opencode.bootstrap.ready' || phase === 'opencode.bootstrap.error'
    ));
    expect(terminalEvents).toHaveLength(1);
  });

  it('recovers an external OPENCODE_HOST connection using its configured endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    globalThis.fetch = fetchMock;
    const runtime = createRuntime({}, {
      openCodePort: null,
      openCodeBaseUrl: null,
      isExternalOpenCode: true,
    }, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await runtime.restartOpenCode();

    expect(runtime.getManagedOpenCodeProcessEnv()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://seamus:4095/api/info',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
    expect(runtime.testState.lastOpenCodeError).toBeNull();
  });

  it('retains the OPENCODE_HOST port after an external re-probe fails', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({}, {
      openCodePort: 4095,
      openCodeBaseUrl: 'http://seamus:4095',
      isExternalOpenCode: true,
    }, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await expect(runtime.restartOpenCode()).rejects.toThrow(
      'External OpenCode server on port 4095 is not responding',
    );

    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
  });

  it('attaches to an OPENCODE_HOST running OpenCode v1 instead of starting a managed server', async () => {
    const requested = [];
    globalThis.fetch = vi.fn(async (url) => {
      const href = String(url);
      requested.push(href);
      if (href.endsWith('/global/health')) return Response.json({ healthy: true, version: '1.18.32' });
      return new Response('<html>OpenCode</html>', { headers: { 'content-type': 'text/html' } });
    });
    const runtime = createRuntime({
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    }, {}, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(requested).toContain('http://seamus:4095/global/health');
    expect(runtime.testState.isExternalOpenCode).toBe(true);
    expect(runtime.testState.isOpenCodeReady).toBe(false);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.lastOpenCodeError).toContain('1.18.32');
  });

  it('warms only the last-used directory after a successful bootstrap', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '2.0.20', pid: 1, urls: [], paths: { tmp: '/tmp' } }),
    }));
    globalThis.fetch = fetchMock;
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
      getWarmupDirectories: vi.fn(async () => ['/tmp/worktree-a', '/tmp/project-b']),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const warmupUrls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/api/session?'));
    // Each warmed directory boots its whole MCP fleet on OpenCode 2 (#4018).
    expect(warmupUrls).toEqual([
      'http://127.0.0.1:45678/api/session?directory=%2Ftmp%2Fworktree-a&limit=1',
    ]);
  });

  it('records an authoritative error terminal event when bootstrap fails', async () => {
    const runtime = createRuntime({
      syncFromHmrState: vi.fn(() => {
        throw new Error('bootstrap failed');
      }),
      reapManagedOrphanedProcesses: vi.fn(async () => ({ reaped: 0 })),
    });

    await runtime.bootstrapOpenCodeAtStartup();

    expect(recordStartupPerformanceMock).toHaveBeenCalledWith('opencode.bootstrap.error', {
      totalDurationMs: expect.any(Number),
      outcome: 'error',
    });
    expect(recordStartupPerformanceMock).not.toHaveBeenCalledWith(
      'opencode.bootstrap.ready',
      expect.anything(),
    );
    const terminalEvents = recordStartupPerformanceMock.mock.calls.filter(([phase]) => (
      phase === 'opencode.bootstrap.ready' || phase === 'opencode.bootstrap.error'
    ));
    expect(terminalEvents).toHaveLength(1);
  });

  it('does not count rapid transport-triggered checks as independent health failures', async () => {
    const close = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 1;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({ now: () => now }, {
      openCodePort: 45678,
      openCodeProcess: {
        managedStartupCapabilities: compiledPolicy,
        pid: null,
        exitCode: null,
        signalCode: null,
        close,
      },
      isOpenCodeReady: true,
    });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await runtime.triggerHealthCheck();
    }

    expect(close).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    now += 15_000;
    await runtime.triggerHealthCheck();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('(2/20)'));
    warn.mockRestore();
  });

  it.each([
    {
      name: 'timeout',
      expectedClass: 'timeout',
      fetchResult: () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    },
    {
      name: 'connection refusal',
      expectedClass: 'connection_refused',
      fetchResult: () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:45678');
        error.code = 'ECONNREFUSED';
        throw error;
      },
    },
    {
      name: 'invalid JSON',
      expectedClass: 'invalid_response',
      fetchResult: () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    },
  ])('classifies and stores a counted $name health failure', async ({ expectedClass, fetchResult }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(fetchResult);
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        managedStartupCapabilities: compiledPolicy,
        pid: process.pid,
        exitCode: null,
        signalCode: null,
        close: vi.fn(async () => {}),
      },
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(runtime.testState.lastOpenCodeHealthFailure).toEqual({
      class: expectedClass,
      detail: expect.any(String),
      at: expect.any(String),
      source: 'immediate',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`class=${expectedClass}`));
    warn.mockRestore();
  });

  it('does not mistake a live managed process wrapper for an exited child', async () => {
    const close = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        managedStartupCapabilities: compiledPolicy,
        pid: process.pid,
        close,
      },
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(close).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(1/20)'));
    warn.mockRestore();
  });

  it('restarts an exited managed process without waiting for the failure interval', async () => {
    const close = vi.fn(async () => {});
    const replacement = createMockChild();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return replacement;
    });
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        managedStartupCapabilities: compiledPolicy,
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    await runtime.triggerHealthCheck();

    expect(close).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenCodeRestarted after a successful managed restart', async () => {
    const close = vi.fn(async () => {});
    const replacement = createMockChild();
    const onOpenCodeRestarted = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return replacement;
    });
    const runtime = createRuntime({ onOpenCodeRestarted }, {
      openCodePort: 45678,
      openCodeProcess: {
        managedStartupCapabilities: compiledPolicy,
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    await runtime.triggerHealthCheck();

    expect(close).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The restart completed on a (possibly new) port — the event-stream
    // upstreams must rebind so the UI keeps receiving events (#2638).
    expect(onOpenCodeRestarted).toHaveBeenCalledTimes(1);
  });

  it('discards private child output but retains exit diagnostics across restart', async () => {
    const firstChild = createMockChild();
    const replacement = createMockChild();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return replacement;
    });
    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = server;

    firstChild.stderr.emit(
      'data',
      `${'x'.repeat(40 * 1024)}\ntoken=runtime-secret\nruntime worker failed after startup\n`,
    );
    firstChild.exitCode = 7;
    firstChild.emit('exit', 7, null);

    expect(server.exitCode).toBe(7);
    expect(Buffer.byteLength(server.stderrTail)).toBeLessThanOrEqual(32 * 1024);
    expect(server.stderrTail).not.toContain('runtime-secret');
    expect(server.stderrTail).toBe('');

    await runtime.triggerHealthCheck();

    expect(runtime.testState.lastOpenCodeRestartDiagnostics).toEqual({
      reason: 'immediate-process-exited',
      healthFailure: null,
      process: {
        pid: 12345,
        exitCode: 7,
        signalCode: null,
        stderrTail: '',
        alive: false,
      },
      busySessionCount: 0,
      at: expect.any(String),
    });
    expect(runtime.testState.lastManagedOpenCodeProcess).toEqual({
      pid: 12345,
      exitCode: 7,
      signalCode: null,
      stderrTail: '',
    });

    await runtime.testState.openCodeProcess.close();
    warn.mockRestore();
  });

  it('never publishes private child stderr in diagnostics', async () => {
    const firstChild = createMockChild();
    const replacement = createMockChild();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return replacement;
    });
    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = server;

    firstChild.stderr.emit(
      'data',
      'request rejected: Authorization: Basic dXNlcjpwYXNz\n'
      + 'authorization: basic bG93ZXI6Y2FzZQ==\n'
      + 'Authorization: Bearer fake-bearer-token-value\n'
      + 'falling back to basic health monitor\n'
      + 'runtime worker failed after startup\n',
    );
    firstChild.exitCode = 7;
    firstChild.emit('exit', 7, null);

    expect(server.stderrTail).not.toContain('dXNlcjpwYXNz');
    expect(server.stderrTail).not.toContain('bG93ZXI6Y2FzZQ');
    expect(server.stderrTail).not.toContain('fake-bearer-token-value');
    expect(server.stderrTail).toBe('');
    expect(server.stderrTail).toBe('');

    await runtime.triggerHealthCheck();

    const diagnosticsTail = runtime.testState.lastOpenCodeRestartDiagnostics.process.stderrTail;
    expect(diagnosticsTail).not.toContain('dXNlcjpwYXNz');
    expect(diagnosticsTail).not.toContain('bG93ZXI6Y2FzZQ');
    expect(diagnosticsTail).not.toContain('fake-bearer-token-value');
    expect(diagnosticsTail).toBe('');
    expect(diagnosticsTail).toBe('');

    await runtime.testState.openCodeProcess.close();
    warn.mockRestore();
  });

  it('does not call onOpenCodeRestarted when a managed restart fails', async () => {
    const close = vi.fn(async () => {});
    const onOpenCodeRestarted = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        child.emit('error', new Error('spawn failed'));
      });
      return child;
    });
    const runtime = createRuntime({ onOpenCodeRestarted }, {
      openCodePort: 45678,
      openCodeProcess: {
        managedStartupCapabilities: compiledPolicy,
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    // triggerHealthCheck logs instead of rethrowing; call restartOpenCode
    // directly to observe the failure result.
    await expect(runtime.restartOpenCode()).rejects.toThrow();

    expect(onOpenCodeRestarted).not.toHaveBeenCalled();
  });

  it('launches managed OpenCode with the managed PATH', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const [binary, args, options] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--compiled-plugins-only', '--hostname', '127.0.0.1', '--port', '45678']);
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.SHELL_ONLY).toBe('yes');
    expect(options.env.OPENCODE_PASSWORD).toBeUndefined();
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(server.exitCode).toBeNull();
    expect(server.signalCode).toBeNull();

    await server.close();
    expect(server.signalCode).toBe('SIGTERM');
  });

  it('launches managed OpenCode on the configured bind hostname', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://0.0.0.0:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return child;
    });

    const runtime = createRuntime({}, {}, { ENV_CONFIGURED_OPENCODE_HOSTNAME: '0.0.0.0' });
    const server = await runtime.startOpenCode();
    const [binary, args] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--compiled-plugins-only', '--hostname', '0.0.0.0', '--port', '45678']);

    await server.close();
    expect(server.signalCode).toBe('SIGTERM');
  });

  it('removes AppImage launcher entries from the managed OpenCode launch env', async () => {
    delete process.env.OPENCODE_BINARY;
    const previous = { APPDIR: process.env.APPDIR, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
    process.env.APPDIR = '/tmp/.mount_OpenChAbC123';
    process.env.LD_LIBRARY_PATH = '/tmp/.mount_OpenChAbC123/usr/lib:/opt/x:';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return child;
    });

    try {
      const runtime = createRuntime();
      const server = await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];

      expect(options.env.LD_LIBRARY_PATH).toBe('/opt/x');

      await server.close();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('strips AppImage ARGV0 from managed OpenCode launch env', async () => {
    delete process.env.OPENCODE_BINARY;
    const previousArgv0 = process.env.ARGV0;
    process.env.ARGV0 = '/path/to/OpenChamber/OpenChamber-1.17.2-linux-x86_64.AppImage';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return child;
    });

    try {
      const runtime = createRuntime({
        getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
          PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
          ARGV0: '/leaked/from/shell/snapshot.AppImage',
          SHELL_ONLY: 'yes',
        })),
      });
      const server = await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];

      expect(options.env).not.toHaveProperty('ARGV0');
      expect(options.env.SHELL_ONLY).toBe('yes');
      expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');

      await server.close();
    } finally {
      if (previousArgv0 === undefined) delete process.env.ARGV0;
      else process.env.ARGV0 = previousArgv0;
    }
  });

  it('adds managed OpenChamber tool environment without allowing it to replace launch invariants', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return child;
    });
    const getManagedOpenCodeEnv = vi.fn(async () => ({
      OPENCODE_CONFIG_CONTENT: '{"plugin":["file:///tool.js"]}',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'ephemeral',
      PATH: '/untrusted/path',
      OPENCODE_PASSWORD: 'untrusted-password',
      OPENCODE_SERVER_PASSWORD: 'untrusted-password',
    }));

    const runtime = createRuntime({ getManagedOpenCodeEnv });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(getManagedOpenCodeEnv).toHaveBeenCalledOnce();
    expect(options.env.OPENCODE_CONFIG_CONTENT).toBe('{"plugin":["file:///tool.js"]}');
    expect(options.env.OPENCHAMBER_AGENT_TOOL_TOKEN).toBeUndefined();
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.OPENCODE_PASSWORD).toBeUndefined();
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();

    await server.close();
  });

  it('mirrors Google credential env aliases into the managed OpenCode environment', async () => {
    const previousGemini = process.env.GEMINI_API_KEY;
    const previousGoogleGen = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const previousGoogle = process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'AIza-from-gemini';
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      const child = createMockChild();
      spawnMock.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
        });
        return child;
      });

      const runtime = createRuntime();
      const server = await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];

      expect(options.env.GEMINI_API_KEY).toBe('AIza-from-gemini');
      expect(options.env.GOOGLE_API_KEY).toBe('AIza-from-gemini');
      expect(options.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('AIza-from-gemini');

      await server.close();
    } finally {
      if (typeof previousGemini === 'string') {
        process.env.GEMINI_API_KEY = previousGemini;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
      if (typeof previousGoogleGen === 'string') {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousGoogleGen;
      } else {
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      }
      if (typeof previousGoogle === 'string') {
        process.env.GOOGLE_API_KEY = previousGoogle;
      } else {
        delete process.env.GOOGLE_API_KEY;
      }
    }
  });

  it('falls back to buildAugmentedPath when buildManagedOpenCodePath is not provided', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: vi.fn(() => '/home/user/.cargo/bin:/usr/local/bin'),
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/home/user/.cargo/bin:/usr/local/bin');

    await server.close();
  });

  it('falls back to process.env.PATH when neither build function is provided', async () => {
    delete process.env.OPENCODE_BINARY;
    process.env.PATH = '/usr/bin:/bin';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: undefined,
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/usr/bin:/bin');

    await server.close();
  });

  it('reports the binary when managed OpenCode exits before becoming ready', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.emit('exit', null, 'SIGTERM');
      });
      return secondChild;
    });

    const runtime = createRuntime();

    await expect(runtime.startOpenCode()).rejects.toThrow('OpenCode exited before its private startup handshake completed.');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry managed startup when the configured OpenCode binary is invalid', async () => {
    delete process.env.OPENCODE_BINARY;
    const error = new Error('Configured OpenCode binary not found: /missing/opencode');
    error.code = 'OPENCODE_BINARY_INVALID';
    const applyOpencodeBinaryFromSettings = vi.fn(async () => {
      throw error;
    });

    const runtime = createRuntime({ applyOpencodeBinaryFromSettings });

    await expect(runtime.startOpenCode()).rejects.toThrow('Configured OpenCode binary not found: /missing/opencode');
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledTimes(1);
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledWith({ strict: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('retries managed OpenCode startup once after a pre-ready exit', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      });
      return secondChild;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it('tops up the v1 session migration before spawning managed OpenCode', async () => {
    const calls = [];
    const topUpV1SessionMigration = vi.fn(() => {
      calls.push('top-up');
      return { status: 'scheduled', missing: 3, revisited: 0 };
    });
    spawnMock.mockImplementation(() => {
      calls.push('spawn');
      const child = createMockChild();
      queueMicrotask(() => child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
      return child;
    });
    globalThis.fetch = vi.fn(async () => ({ ok: false }));

    const runtime = createRuntime({ topUpV1SessionMigration });
    await runtime.startOpenCode();

    expect(topUpV1SessionMigration).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['top-up', 'spawn']);
  });

});

describe('killProcessOnPort on Windows', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  const setPlatform = (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  };

  it('force-kills the process listening on the target port via taskkill', () => {
    setPlatform('win32');
    const orphanPid = 54321;
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'powershell') {
        return { stdout: `${orphanPid}\r\n` };
      }
      return { stdout: '' };
    });

    const runtime = createRuntime();
    runtime.killProcessOnPort(45678);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'powershell',
      expect.arrayContaining([expect.stringContaining('-LocalPort 45678')]),
      expect.objectContaining({ windowsHide: true })
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', String(orphanPid), '/F'],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it('never force-kills its own process id', () => {
    setPlatform('win32');
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'powershell') {
        return { stdout: `${process.pid}\r\n` };
      }
      return { stdout: '' };
    });

    const runtime = createRuntime();
    runtime.killProcessOnPort(45678);

    expect(spawnSyncMock).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
  });

  it('does nothing when no process is listening on the target port', () => {
    setPlatform('win32');
    spawnSyncMock.mockImplementation((cmd) => {
      if (cmd === 'powershell') {
        return { stdout: '' };
      }
      return { stdout: '' };
    });

    const runtime = createRuntime();
    runtime.killProcessOnPort(45678);

    expect(spawnSyncMock).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
  });
});

it('shares the managed CLI preflight with desktop while startup is pending', async () => {
  let finish;
  let entered;
  const checking = new Promise(resolve => { entered = resolve; });
  const check = new Promise(resolve => { finish = resolve; });
  let checks = 0;
  const runtime = createRuntime({
    checkOpenCodeBinary: () => { checks += 1; entered(); return check; },
    ensureOpencodeCliEnv: () => '/tmp/opencode',
  });
  spawnMock.mockImplementation(() => {
    const child = createMockChild();
    queueMicrotask(() => child.stdout.emit('data', 'openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":0}\nserver listening on http://127.0.0.1:45678\nserver password aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
    return child;
  });
  expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
  const starting = runtime.startOpenCode();
  await checking;
  const desktopVerdict = runtime.getManagedOpenCodePreflight();
  expect(runtime.testState.isOpenCodeReady).toBe(false);
  finish('2.0.20');
  expect(await desktopVerdict).toBe(true);
  expect(checks).toBe(1);
  const server = await starting;
  try {
    expect(await runtime.getManagedOpenCodePreflight()).toBe(true);
    runtime.testState.isExternalOpenCode = true;
    expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
    runtime.testState.isExternalOpenCode = false;
    runtime.testState.isShuttingDown = true;
    expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
  } finally {
    await server.close();
  }
});

it('a rejected CLI preflight never permits desktop bootstrap', async () => {
  const runtime = createRuntime({
    checkOpenCodeBinary: async () => {
      throw Object.assign(new Error('Unsupported CLI'), { code: 'OPENCODE_BINARY_INVALID' });
    },
  });
  await expect(runtime.startOpenCode()).rejects.toThrow('Unsupported CLI');
  expect(await runtime.getManagedOpenCodePreflight()).toBe(false);
  expect(spawnMock).not.toHaveBeenCalled();
});
