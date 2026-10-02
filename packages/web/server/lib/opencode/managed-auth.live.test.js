import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { describe, expect, it } from 'vitest';
import { createOpenCodeAuthStateRuntime } from './auth-state-runtime.js';
import { createOpenCodeLifecycleRuntime } from './lifecycle.js';
import { createOpenCodeNetworkRuntime } from './network-runtime.js';

// Opt-in, real CLI integration. No provider credentials, prompts, user config,
// shared service, or model traffic. All files belong to this temporary test run.
const binary = process.env.OPENCHAMBER_TEST_OPENCODE_BINARY;

const prepareInstance = async (root) => {
  for (const directory of ['home', 'data', 'cache', 'config', 'state', 'project']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  const marker = path.join(root, 'mcp-env.json');
  const mcp = path.join(root, 'mcp.cjs');
  await fs.writeFile(mcp, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, keys: Object.keys(process.env).filter(k => /^(OPENCODE_PASSWORD|OPENCODE_SERVER_PASSWORD)$/i.test(k)) }));
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = request.method === 'initialize'
        ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'private-auth-test', version: '1' } }
        : { tools: [] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `);
  const config = path.join(root, 'config', 'opencode.json');
  await fs.writeFile(config, JSON.stringify({
    mcp: { servers: { 'private-auth-test': { type: 'local', command: [process.execPath, mcp] } } },
  }));
  const environment = {
    PATH: process.env.PATH,
    HOME: path.join(root, 'home'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_DB: path.join(root, 'data', 'opencode.db'), OPENCODE_CONFIG_DIR: path.join(root, 'config'),
    OPENCODE_CONFIG: config, OPENCODE_CONFIG_PROJECT_DISABLE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_FILEWATCHER_DISABLE: '1', OPENCODE_DISABLE_FFF: '1',
    OPENCHAMBER_MANAGED_PROCESS_REGISTRY: path.join(root, 'registry'),
  };
  const state = { openCodeWorkingDirectory: path.join(root, 'project'), openCodePort: null, isShuttingDown: false };
  const auth = createOpenCodeAuthStateRuntime({ state, syncToHmrState() {} });
  const network = createOpenCodeNetworkRuntime({ state, getOpenCodeAuthHeaders: auth.getOpenCodeAuthHeaders });
  const lifecycle = createOpenCodeLifecycleRuntime({
    state, env: { ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1' },
    syncToHmrState() {}, syncFromHmrState() {},
    ...auth, ...network,
    ensureOpencodeCliEnv: () => binary, applyOpencodeBinaryFromSettings: async () => {},
    resolveManagedOpenCodeLaunchSpec: (executable) => ({ binary: executable, args: [] }),
    setOpenCodePort: (port) => { state.openCodePort = port; },
    topUpV1SessionMigration: () => ({ status: 'skipped' }),
    getManagedOpenCodeEnv: async () => ({ ...environment, OPENCODE_PASSWORD: 'must-be-stripped', OPENCODE_SERVER_PASSWORD: 'must-also-be-stripped' }),
    managedStartupTimeoutMs: 30_000,
  });
  return { root, marker, environment, state, auth, lifecycle, getPassword: () => state.openCodeAuthPassword };
};

const assertProcessPrivate = async (pid, password) => {
  for (const file of ['environ', 'cmdline']) {
    const text = await fs.readFile(`/proc/${pid}/${file}`, 'utf8');
    expect(text.includes(password), `${file} must not contain the generated credential`).toBe(false);
    expect(/OPENCODE_(SERVER_)?PASSWORD/i.test(text), `${file} must not contain server auth variables`).toBe(false);
  }
};

const assertFilesPrivate = async (root, password) => {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await assertFilesPrivate(file, password);
    else if (entry.isFile()) {
      const bytes = await fs.readFile(file);
      expect(bytes.includes(Buffer.from(password)), 'managed credential must not be persisted').toBe(false);
    }
  }
};

describe.runIf(Boolean(binary) && process.platform === 'linux')('real OpenCode private authentication', () => {
  it('isolates concurrent credentials, shell/MCP children, crashes and fresh starts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-private-auth-live-'));
    const originalEnvironment = process.env;
    const first = await prepareInstance(path.join(root, 'first'));
    const second = await prepareInstance(path.join(root, 'second'));
    // This Vitest file owns its worker. Strip unrelated test-runner/host secrets
    // before spawning an actual OpenCode process and preserve the caller's env.
    process.env = { PATH: originalEnvironment.PATH, NO_PROXY: originalEnvironment.NO_PROXY, no_proxy: originalEnvironment.no_proxy, ...first.environment };
    const servers = [];
    try {
      const pair = await Promise.all([first.lifecycle.startOpenCode(), second.lifecycle.startOpenCode()]);
      servers.push(...pair);
      const secrets = [first.getPassword(), second.getPassword()];
      expect(secrets.every((secret) => /^[A-Za-z0-9_-]{43}$/.test(secret))).toBe(true);
      expect(secrets[0] === secrets[1], 'parallel processes need separate credentials').toBe(false);
      for (const [index, instance] of [first, second].entries()) {
        const server = pair[index];
        const headers = instance.auth.getOpenCodeAuthHeaders();
        const client = OpenCode.make({ baseUrl: server.url, headers });
        expect((await client.server.info()).pid).toBe(server.pid);
        expect((await fetch(`${server.url}/api/info`, { redirect: 'error' })).status).toBe(401);
        const other = index === 0 ? second : first;
        expect((await fetch(`${server.url}/api/info`, { headers: other.auth.getOpenCodeAuthHeaders(), redirect: 'error' })).status).toBe(401);
        await assertProcessPrivate(server.pid, secrets[index]);
        expect(JSON.stringify(server).includes(secrets[index])).toBe(false);
        expect(JSON.stringify(instance.lifecycle.getManagedOpenCodeProcessEnv()).includes(secrets[index])).toBe(false);
        const location = { directory: path.join(instance.root, 'project') };
        await client.mcp.list({ location });
        await expect.poll(async () => fs.readFile(instance.marker, 'utf8').catch(() => ''), { timeout: 15_000 }).not.toBe('');
        const mcp = JSON.parse(await fs.readFile(instance.marker, 'utf8'));
        expect(mcp.keys).toEqual([]);
        await assertProcessPrivate(mcp.pid, secrets[index]);
        const shellMarker = path.join(instance.root, 'shell-env.txt');
        await client.shell.create({ location, command: `/usr/bin/env > ${JSON.stringify(shellMarker)}`, timeout: 5000 });
        await expect.poll(async () => fs.readFile(shellMarker, 'utf8').catch(() => ''), { timeout: 10_000 }).not.toBe('');
        const shellEnvironment = await fs.readFile(shellMarker, 'utf8');
        expect(shellEnvironment.includes(secrets[index])).toBe(false);
        expect(/OPENCODE_(SERVER_)?PASSWORD/i.test(shellEnvironment)).toBe(false);
      }
      // A crash invalidates auth immediately; a fresh owned launch gets a new
      // secret and the previous credential cannot authorize the replacement.
      process.kill(pair[0].pid, 'SIGKILL');
      await expect.poll(() => first.auth.isOpenCodeConnectionSecure()).toBe(false);
      expect(() => first.auth.getOpenCodeAuthHeaders()).toThrow('not ready');
      await pair[0].close();
      const replacement = await first.lifecycle.startOpenCode();
      servers.push(replacement);
      expect(first.getPassword() === secrets[0], 'restart must rotate the credential').toBe(false);
      const previousHeaders = { Authorization: `Basic ${Buffer.from(`opencode:${secrets[0]}`).toString('base64')}` };
      expect((await fetch(`${replacement.url}/api/info`, { headers: previousHeaders, redirect: 'error' })).status).toBe(401);
      await replacement.close();
      expect(first.auth.isOpenCodeConnectionSecure()).toBe(false);
      await pair[1].close();
      await assertFilesPrivate(root, secrets[0]);
      await assertFilesPrivate(root, secrets[1]);
    } finally {
      await Promise.allSettled(servers.map((server) => server.close()));
      process.env = originalEnvironment;
      // Keep isolated artifacts available for review, without captured secrets.
      console.log(`Private-auth live test artifacts: ${root}`);
    }
  }, 120_000);
});
