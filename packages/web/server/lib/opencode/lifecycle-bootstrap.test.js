import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeLifecycleRuntime } from './lifecycle.js';

const fixtures = [];
const originalRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
afterEach(async () => {
  for (const { root, state } of fixtures.splice(0)) {
    state.isShuttingDown = true;
    await state.openCodeProcess?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
  if (originalRegistry === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = originalRegistry;
  vi.restoreAllMocks();
});

const fixture = async (mode = 'valid', dependencies = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-bootstrap-'));
  process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(root, 'registry');
  const state = { openCodeWorkingDirectory: root, openCodeProcess: null, isShuttingDown: false };
  fixtures.push({ root, state });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  await fs.writeFile(path.join(root, 'serve'), `
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const mode = ${JSON.stringify(mode)};
    if (!process.argv.includes('--compiled-plugins-only')) process.exit(98);
    if (mode === 'stock') {
      process.stderr.write('Unknown option --compiled-plugins-only');
      process.exit(1);
    }
    fs.appendFileSync('spawned', process.pid + '\\n');
    if (mode === 'close-input') { process.stdin.destroy(); process.exit(1); }
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      const payload = input ? JSON.parse(input) : null;
      const descendant = require('node:child_process').execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({env: process.env, argv: process.argv}))'], { encoding: 'utf8' });
      fs.writeFileSync('observed.json', JSON.stringify({
        env: process.env, argv: process.argv, descendant: JSON.parse(descendant),
        eof: true, version: payload?.version, catalog: payload?.catalog,
        tokenHash: payload ? crypto.createHash('sha256').update(payload.token).digest('hex') : null,
      }));
      if (mode === 'silent') return;
      if (payload) process.stderr.write(payload.token);
      if (mode !== 'missing-capability') process.stdout.write('openchamber capabilities ' + JSON.stringify({
        version: 1, compiledPluginsOnly: true,
        agentToolsBootstrap: mode === 'mismatch' ? 0 : payload ? 1 : 0,
      }) + '\\n');
      process.stdout.write('server listening on http://127.0.0.1:45678\\nserver password ' + crypto.randomBytes(32).toString('base64url') + '\\n');
    });
    setInterval(() => {}, 1000);
  `);
  const tokens = [];
  const revoked = [];
  const getManagedOpenCodeBootstrap = async () => {
    const token = randomBytes(32).toString('base64url');
    tokens.push(token);
    return {
      payload: { version: 1, url: 'http://127.0.0.1:32123', token, catalog: [{ name: 'fixture' }] },
      revoke: () => { revoked.push(token); },
    };
  };
  const options = {
    state,
    env: { ENV_CONFIGURED_OPENCODE_PORT: 45678, ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1' },
    syncToHmrState() {}, syncFromHmrState() {},
    checkOpenCodeBinary: async () => '2.0.21',
    ensureOpencodeCliEnv: () => process.execPath,
    applyOpencodeBinaryFromSettings: async () => {},
    setManagedOpenCodePassword: (password) => { state.password = password; },
    resolveManagedOpenCodeLaunchSpec: (binary) => ({ binary, args: [] }),
    normalizeApiPrefix: (value) => value,
    setOpenCodePort() {}, setDetectedOpenCodeApiPrefix() {},
    waitForReady: async () => true,
    topUpV1SessionMigration: () => ({ status: 'skipped' }),
    getManagedOpenCodeEnv: async () => ({
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'legacy-tool-secret',
      openchamber_agent_tool_url: 'http://legacy.invalid',
      OPENCODE_PASSWORD: 'legacy-password',
      opencode_server_password: 'legacy-password2',
      FIXTURE_PROVIDER_KEY: 'provider-still-present',
      OPENCHAMBER_MANAGED_PROCESS_REGISTRY: path.join(root, 'registry'),
    }),
    getManagedOpenCodeBootstrap,
    managedStartupTimeoutMs: 500,
    ...dependencies,
  };
  const runtime = createOpenCodeLifecycleRuntime(options);
  return { root, state, runtime, tokens, revoked, log, errorLog, options };
};

const assertNoSecret = async ({ root, state, runtime, tokens, log, errorLog }) => {
  const observed = await fs.readFile(path.join(root, 'observed.json'), 'utf8');
  const serialized = JSON.stringify({ state, env: runtime.getManagedOpenCodeProcessEnv(), logs: log.mock.calls, errors: errorLog.mock.calls });
  for (const token of tokens) {
    expect(observed).not.toContain(token);
    expect(serialized).not.toContain(token);
  }
  expect(/openchamber_agent_tool_(token|url)|opencode_(server_)?password/i.test(observed)).toBe(false);
  expect(observed).toContain('provider-still-present');
  return JSON.parse(observed);
};

describe('private compiled OpenCode bootstrap', () => {
  it('keeps the same proven process and credentials across lifecycle HMR', async () => {
    const f = await fixture();
    const server = await f.runtime.startOpenCode();
    const password = f.state.password;
    const proof = server.managedStartupCapabilities;
    expect(Object.isFrozen(proof)).toBe(true);
    const reloaded = createOpenCodeLifecycleRuntime(f.options);
    expect(f.state.password).toBe(password);
    expect(await reloaded.startOpenCode()).toBe(server);
    expect(f.tokens).toHaveLength(1);
    expect(f.revoked).toHaveLength(0);
    expect(server.managedStartupCapabilities).toBe(proof);
    const closing = server.close();
    expect(server.managedStartupCapabilities).toBe(null);
    expect(f.state.password).toBe(null);
    await closing;
  });

  it('replaces a live HMR handle missing its proof and revokes only the old grant', async () => {
    const f = await fixture();
    const old = await f.runtime.startOpenCode();
    // Simulate an owned handle restored from the pre-capability lifecycle.
    f.state.openCodeProcess = { pid: old.pid, close: old.close, exitCode: null, signalCode: null };
    const reloaded = createOpenCodeLifecycleRuntime(f.options);
    expect(f.state.password).toBe(null);
    expect(f.state.isOpenCodeReady).toBe(false);
    const current = await reloaded.startOpenCode();
    expect(current.pid).not.toBe(old.pid);
    expect(old.managedStartupCapabilities).toBe(null);
    expect(f.revoked).toEqual([f.tokens[0]]);
    expect(current.managedStartupCapabilities).toEqual({ version: 1, compiledPluginsOnly: true, agentToolsBootstrap: 1 });
    await old.close();
    expect(f.revoked).toEqual([f.tokens[0]]);
    expect(f.state.password).not.toBe(null);
    await current.close();
    expect(f.revoked).toEqual(f.tokens);
  });

  for (const key of ['currentStartPromise', 'currentRestartPromise']) {
    it(`stops a live unproven child when inherited ${key} rejects`, async () => {
      const f = await fixture();
      const old = await f.runtime.startOpenCode();
      f.state.openCodeProcess = { pid: old.pid, close: old.close, exitCode: null, signalCode: null };
      let reject;
      f.state[key] = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
      const reloaded = createOpenCodeLifecycleRuntime(f.options);
      const result = reloaded.startOpenCode().catch((error) => error);
      reject(new Error('private old startup failure'));
      expect((await result).message).toContain('inherited OpenCode startup operation failed');
      expect(f.state.openCodeProcess).toBe(null);
      expect(f.state[key]).toBe(null);
      expect(f.state.password).toBe(null);
      expect(old.managedStartupCapabilities).toBe(null);
      expect(f.revoked).toEqual(f.tokens);
      expect(() => process.kill(old.pid, 0)).toThrow();
      const next = await reloaded.startOpenCode();
      expect(next.pid).not.toBe(old.pid);
      await next.close();
    });
  }

  it('delivers one bounded document over stdin and revokes each launch once', async () => {
    const f = await fixture();
    for (let launch = 0; launch < 2; launch++) {
      const [server, joined] = await Promise.all([f.runtime.startOpenCode(), f.runtime.startOpenCode()]);
      expect(server).toBe(joined);
      expect(f.tokens).toHaveLength(launch + 1);
      const observed = await assertNoSecret(f);
      expect(observed.eof).toBe(true);
      expect(observed.version).toBe(1);
      expect(observed.catalog).toEqual([{ name: 'fixture' }]);
      expect(observed.tokenHash).toBe(createHash('sha256').update(f.tokens[launch]).digest('hex'));
      expect(observed.argv).toContain('--compiled-plugins-only');
      expect(observed.argv).toContain('--openchamber-bootstrap');
      await Promise.all([server.close(), server.close()]);
      expect(f.revoked).toEqual(f.tokens);
    }
    expect(new Set(f.tokens).size).toBe(2);
  });

  for (const mode of ['mismatch', 'missing-capability', 'stock', 'close-input', 'silent']) {
    it(`fails closed and revokes on ${mode}`, async () => {
      const f = await fixture(mode);
      await expect(f.runtime.startOpenCode()).rejects.toThrow(/OpenCode/);
      expect(f.revoked).toEqual(f.tokens);
      expect(f.tokens).toHaveLength(2);
      expect(f.state.password).toBe(null);
      for (const token of f.tokens) {
        expect(JSON.stringify({ state: f.state, logs: f.log.mock.calls, errors: f.errorLog.mock.calls })).not.toContain(token);
      }
      if (mode === 'stock') {
        expect(await fs.readFile(path.join(f.root, 'spawned'), 'utf8').catch(() => null)).toBe(null);
        expect(f.state.lastOpenCodeError).toContain('compiled-plugins-only build');
      }
    });
  }

  it('revokes immediately when a ready engine exits', async () => {
    const f = await fixture();
    const server = await f.runtime.startOpenCode();
    process.kill(server.pid, 'SIGTERM');
    await expect.poll(() => f.revoked).toEqual(f.tokens);
    expect(f.state.password).toBe(null);
    expect(f.state.isOpenCodeReady).toBe(false);
    await server.close();
    expect(f.revoked).toEqual(f.tokens);
  });

  it('revokes grants after a spawn error without recording their payload', async () => {
    const f = await fixture('valid', { ensureOpencodeCliEnv: () => '/nonexistent/openchamber-test-engine' });
    await expect(f.runtime.startOpenCode()).rejects.toThrow('process could not start');
    expect(f.revoked).toEqual(f.tokens);
    expect(f.tokens).toHaveLength(2);
    for (const token of f.tokens) {
      expect(JSON.stringify({ state: f.state, logs: f.log.mock.calls, errors: f.errorLog.mock.calls })).not.toContain(token);
    }
  });

  it('rejects oversized documents before spawn and revokes the unused grant', async () => {
    let revocations = 0;
    const f = await fixture('valid', {
      getManagedOpenCodeBootstrap: async () => ({ payload: { version: 1, token: 'x'.repeat(65536) }, revoke() { revocations++; } }),
    });
    await expect(f.runtime.startOpenCode()).rejects.toThrow('64 KiB');
    expect(revocations).toBe(2);
    expect(await fs.readFile(path.join(f.root, 'spawned'), 'utf8').catch(() => null)).toBe(null);
  });

  it('revokes a bootstrap that arrives after shutdown without spawning a child', async () => {
    let release;
    let revocations = 0;
    const pending = new Promise((resolve) => { release = resolve; });
    const f = await fixture('valid', { getManagedOpenCodeBootstrap: () => pending });
    const starting = f.runtime.startOpenCode();
    const result = expect(starting).rejects.toThrow('cancelled during shutdown');
    await new Promise((resolve) => setImmediate(resolve));
    f.state.isShuttingDown = true;
    release({ payload: { version: 1 }, revoke() { revocations++; } });
    await result;
    expect(revocations).toBe(1);
    expect(await fs.readFile(path.join(f.root, 'spawned'), 'utf8').catch(() => null)).toBe(null);
  });

  it('uses compiled-only mode zero without an AgentTool grant', async () => {
    const f = await fixture('valid', { getManagedOpenCodeBootstrap: async () => null });
    const server = await f.runtime.startOpenCode();
    const observed = await assertNoSecret(f);
    expect(observed.argv).toContain('--compiled-plugins-only');
    expect(observed.argv).not.toContain('--openchamber-bootstrap');
    expect(observed.tokenHash).toBe(null);
    await server.close();
  });
});
