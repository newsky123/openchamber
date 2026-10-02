import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnManagedOpenCodeProcess } from './managed-opencode-process';

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const readPids = async (marker: string) => (await fs.readFile(marker, 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(Number);

for (const mode of ['timeout', 'malformed', 'missing_password', 'stderr_credentials', 'wrong_url', 'abort', 'close', 'ready', 'late_abort', 'exit']) {
  test(`managed ${mode} reaps parent and SIGTERM-resistant descendant`, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-managed-'));
    const marker = path.join(cwd, 'pids');
    const registry = path.join(cwd, 'registry');
    const previous = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = registry;
    const descendant = `process.on('SIGTERM', () => {}); require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n'); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const readyMode = ['ready', 'late_abort', 'exit'].includes(mode);
    const privateDiagnostic = 'fixture-private-output-must-not-escape';
    let output = '';
    if (mode === 'malformed') output = `process.stdout.write('server listening on http://127.0.0.1:45678\\nserver password invalid\\n');`;
    if (mode === 'missing_password') output = `process.stdout.write('server listening on http://127.0.0.1:45678\\n');`;
    if (mode === 'wrong_url') output = `process.stdout.write('server listening on http://127.0.0.1:45679\\nserver password ' + password + '\\n');`;
    if (mode === 'stderr_credentials') output = `process.stderr.write('server listening on http://127.0.0.1:45678\\nserver password ' + password + '\\n');`;
    if (readyMode) output = `process.stdout.write('server listening on http://127.0.0.1:45678\\nserver password ' + password + '\\n');`;

    const script = `
      require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      const password = require('node:crypto').randomBytes(32).toString('base64url');
      process.stdout.write(${JSON.stringify(privateDiagnostic)} + '\\n');
      process.stderr.write(${JSON.stringify(privateDiagnostic)} + password + '\\n');
      child.stdout.once('data', () => { ${output} });
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    const server = spawnManagedOpenCodeProcess(process.execPath, ['-e', script], {
      cwd, env: process.env, port: 45678, timeoutMs: 1500,
      signal: controller.signal, sourceBinary: process.execPath,
    });
    const result = server.ready.then(() => null, (error: Error) => error);
    try {
      let pids: number[] = [];
      for (let attempt = 0; attempt < 150; attempt++) {
        pids = await readPids(marker);
        if (pids.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(pids.length, 2, 'both fixture processes must run');
      if (mode === 'abort' || mode === 'timeout') {
        assert.equal(server.url, null);
        assert.ok(await fs.stat(path.join(registry, `${pids[0]}.json`)), 'ownership must exist before readiness');
      }
      if (mode === 'abort') controller.abort();
      if (mode === 'close') void server.close();
      const error = await result;
      if (readyMode) {
        assert.equal(error, null);
        assert.equal(server.url, 'http://127.0.0.1:45678');
        assert.match(server.getAuthHeaders().Authorization, /^Basic /);
        assert.equal(JSON.stringify(server).includes('Authorization'), false);
        if (mode === 'late_abort') {
          controller.abort();
          assert.equal(server.url, null, 'late abort clears auth before explicit close');
          assert.throws(() => server.getAuthHeaders(), /authentication is not ready/);
          await server.closed;
        }
        if (mode === 'exit') {
          process.kill(pids[0], 'SIGTERM');
          await server.closed;
        }
        const closing = server.close();
        assert.equal(server.url, null);
        assert.throws(() => server.getAuthHeaders(), /authentication is not ready/);
        await Promise.all([closing, server.close()]);
      } else {
        assert.ok(error);
        assert.equal(error.message.includes(privateDiagnostic), false);
        assert.equal(server.url, null);
        assert.throws(() => server.getAuthHeaders(), /authentication is not ready/);
      }
      for (let attempt = 0; attempt < 100 && pids.some(alive); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(pids.filter(alive), []);
      assert.deepEqual(await fs.readdir(registry), []);
    } finally {
      await server.close().catch(() => {});
      for (const pid of await readPids(marker)) if (alive(pid)) process.kill(pid, 'SIGKILL');
      if (previous === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
      else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previous;
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}

test('managed launches strip both password names, preserve provider env, and rotate privately', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-private-env-'));
  const registry = path.join(cwd, 'registry');
  const previousRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  const previousPassword = process.env.OPENCODE_PASSWORD;
  process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = registry;
  process.env.OPENCODE_PASSWORD = 'external-server-password-must-stay-unchanged';
  const inheritedEnv = {
    ...process.env,
    OPENCODE_SERVER_PASSWORD: 'legacy-external-server-password',
    opencode_password: 'case-insensitive-password',
    OpenCode_Server_Password: 'mixed-case-password',
    OPENAI_API_KEY: 'fixture-provider-key',
  };
  const fixture = path.join(cwd, 'server.cjs');
  await fs.writeFile(fixture, `
    const fs = require('node:fs');
    const childProcess = require('node:child_process');
    const password = require('node:crypto').randomBytes(32).toString('base64url');
    const descendant = childProcess.execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({env: process.env, argv: process.argv}))'], { encoding: 'utf8' });
    fs.writeFileSync('observed.json', JSON.stringify({ env: process.env, argv: process.argv, descendant: JSON.parse(descendant) }));
    process.stdout.write('server listening on http://127.0.0.1:45678\\nserver password ' + password + '\\n');
    setInterval(() => { process.stdout.write('private trailing output\\n'); process.stderr.write('private trailing errors\\n'); }, 10);
  `);
  let server: ReturnType<typeof spawnManagedOpenCodeProcess> | null = null;
  try {
    const passwords = new Set<string>();
    for (let launch = 0; launch < 2; launch++) {
      server = spawnManagedOpenCodeProcess(process.execPath, [fixture], {
        cwd, env: inheritedEnv, port: 45678, timeoutMs: 3000,
        signal: new AbortController().signal, sourceBinary: process.execPath,
      });
      assert.equal(server.url, null);
      assert.throws(() => server?.getAuthHeaders(), /authentication is not ready/);
      await server.ready;
      const authorization = server.getAuthHeaders().Authorization;
      const password = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8').slice('opencode:'.length);
      assert.match(password, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(passwords.has(password), false, 'every restart must use a new server-generated password');
      passwords.add(password);
      const observed = await fs.readFile(path.join(cwd, 'observed.json'), 'utf8');
      assert.equal(observed.includes(password), false, 'parent and descendant env/argv must not contain the generated secret');
      assert.equal(/opencode_(server_)?password/i.test(observed), false, 'both password names must be absent case-insensitively');
      assert.equal(observed.includes('fixture-provider-key'), true, 'provider credentials still reach OpenCode');
      assert.equal(JSON.stringify(server).includes(password), false, 'serializing the process handle must not reveal its secret');
      assert.equal(process.env.OPENCODE_PASSWORD, 'external-server-password-must-stay-unchanged');
      assert.equal(inheritedEnv.OPENCODE_SERVER_PASSWORD, 'legacy-external-server-password');
      await server.close();
      assert.throws(() => server?.getAuthHeaders(), /authentication is not ready/);
      assert.equal(server.url, null);
    }
  } finally {
    await server?.close();
    if (previousRegistry === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previousRegistry;
    if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD;
    else process.env.OPENCODE_PASSWORD = previousPassword;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('closing an older managed process cannot clear a concurrent process credential', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-concurrent-auth-'));
  const previousRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(cwd, 'registry');
  const script = `
    const password = require('node:crypto').randomBytes(32).toString('base64url');
    process.stdout.write('server listening on http://127.0.0.1:45678\\nserver password ' + password + '\\n');
    setInterval(() => {}, 1000);
  `;
  const olderAbort = new AbortController();
  const older = spawnManagedOpenCodeProcess(process.execPath, ['-e', script], {
    cwd, env: process.env, port: 45678, timeoutMs: 3000, signal: olderAbort.signal, sourceBinary: process.execPath,
  });
  const newer = spawnManagedOpenCodeProcess(process.execPath, ['-e', script], {
    cwd, env: process.env, port: 45678, timeoutMs: 3000, signal: new AbortController().signal, sourceBinary: process.execPath,
  });
  try {
    await Promise.all([older.ready, newer.ready]);
    const newerAuthorization = newer.getAuthHeaders().Authorization;
    assert.notEqual(older.getAuthHeaders().Authorization, newerAuthorization);
    olderAbort.abort();
    await older.closed;
    assert.throws(() => older.getAuthHeaders(), /authentication is not ready/);
    assert.equal(newer.getAuthHeaders().Authorization, newerAuthorization);
    assert.equal(newer.url, 'http://127.0.0.1:45678');
  } finally {
    await Promise.all([older.close(), newer.close()]);
    if (previousRegistry === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previousRegistry;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
