import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('embeds 2.0.21, keeps API and credential transport and persists transcripts across restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-embedded-'));
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import express from 'express';
    import { OpenCode } from '@opencode/client';
    import { createEmbeddedOpenCode, fetchOpenCode } from ${JSON.stringify(new URL('./embedded-runtime.js', import.meta.url).href)};
    import { registerOpenCodeProxy } from ${JSON.stringify(new URL('./proxy.js', import.meta.url).href)};
    import { openCodeCredentialSource } from ${JSON.stringify(new URL('./auth.js', import.meta.url).href)};
    const directory = process.env.TEST_DIRECTORY;
    const neutralDirectory = directory + '/neutral';
    fs.mkdirSync(neutralDirectory);
    const originalCwd = process.cwd();
    const options = { directory: neutralDirectory, databasePath: directory + '/opencode.db', options: { models: { fetch: false, snapshot: true }, fs: { filewatcher: false, fff: false } } };
    const previousPtyBinary = process.env.OPENCODE_PTY_BIN;
    const previousLibraryPath = process.env.LD_LIBRARY_PATH;
    let host = await createEmbeddedOpenCode(options);
    let server;
    try {
      const info = await (await host.fetch(host.url + '/api/info')).json();
      assert.equal(info.pid, process.pid);
      assert.equal(info.version, '2.0.21');
      assert.deepEqual(info.urls, []);
      assert.equal(process.env.LD_LIBRARY_PATH, undefined);
      if (process.platform !== 'win32') assert.ok(fs.existsSync(process.env.OPENCODE_PTY_BIN));
      await assert.rejects(createEmbeddedOpenCode(options), /already running/);
      const client = OpenCode.make({ baseUrl: host.url, fetch: fetchOpenCode });
      const defaultSession = await client.session.create({ title: 'neutral directory' });
      assert.equal(defaultSession.location.directory, neutralDirectory);
      assert.equal(process.cwd(), originalCwd);
      assert.equal((await (await host.fetch(host.url + '/api/location')).json()).directory, neutralDirectory);
      const credentials = openCodeCredentialSource({ buildOpenCodeUrl: (route) => host.url + route, getOpenCodeAuthHeaders: () => ({}) });
      assert.deepEqual(await credentials.list(), []);
      const session = await client.session.create({ title: '持久化测试', location: { directory } });
      assert.equal(session.location.directory, directory);
      const transfer = await client.session.export({ sessionID: session.id });
      const transcript = [
        { id: 'msg_user', type: 'user', time: { created: Date.now() }, text: '请保留这段对话', files: [] },
        { id: 'msg_assistant', type: 'assistant', time: { created: Date.now(), completed: Date.now() }, agent: 'build', model: { id: 'test', providerID: 'test' }, content: [{ type: 'text', text: '这段回答会保存在磁盘。' }], finish: 'stop' },
      ];
      const imported = await client.session.import({ info: { ...transfer.info, id: session.id + 'copy' }, messages: transcript });
      await client.session.prompt({ sessionID: session.id, id: 'msg_pending', text: '重启后仍然排队', resume: false });
      const app = express();
      app.use(express.json());
      registerOpenCodeProxy(app, { fs, OPEN_CODE_READY_GRACE_MS: 1000, LONG_REQUEST_TIMEOUT_MS: 5000,
        getRuntime: () => ({ openCodeBaseUrl: host.url, openCodePort: null, isOpenCodeReady: true }),
        getOpenCodeAuthHeaders: () => ({}), buildOpenCodeUrl: (route) => host.url + route,
        ensureOpenCodeApiPrefix: async () => {}, readWorktreeBootstrapStatus: async () => ({ status: 'ready' }),
      });
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      const base = 'http://127.0.0.1:' + server.address().port;
      assert.equal((await (await fetch(base + '/api/info')).json()).pid, process.pid);
      const unicodeDirectory = directory + '/中文项目';
      fs.mkdirSync(unicodeDirectory);
      const scoped = await fetch(base + '/api/location', { headers: { 'x-opencode-directory': encodeURIComponent(unicodeDirectory), 'x-opencode-directory-encoding': 'uri' } });
      assert.equal(scoped.status, 200);
      assert.equal((await scoped.json()).directory, unicodeDirectory);
      const created = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '代理创建', location: { directory } }) });
      assert.equal(created.status, 200);
      assert.equal((await created.json()).data.title, '代理创建');
      const reader = (await host.fetch(host.url + '/api/event')).body.getReader();
      assert.equal((await reader.read()).done, false);
      await host.close();
      assert.equal(process.env.OPENCODE_PTY_BIN, previousPtyBinary);
      assert.equal(process.env.LD_LIBRARY_PATH, previousLibraryPath);
      await assert.rejects(reader.read());
      await assert.rejects(host.fetch(host.url + '/api/info'), /closed/);
      host = await createEmbeddedOpenCode(options);
      const restored = OpenCode.make({ baseUrl: host.url, fetch: fetchOpenCode });
      assert.deepEqual((await restored.session.export({ sessionID: imported.id })).messages, transcript);
      assert.equal((await restored.session.inbox.list({ sessionID: session.id }))[0].payload.text, '重启后仍然排队');
      const abort = new AbortController();
      const stream = await host.fetch(host.url + '/api/event', { signal: abort.signal });
      const abortedReader = stream.body.getReader();
      await abortedReader.read();
      abort.abort(new Error('cancel stream'));
      await assert.rejects(abortedReader.read(), /cancel stream/);
      assert.ok(fs.statSync(options.databasePath).size > 0);
      console.log('embedded 2.0.21 API, credentials, persistence, proxy and cancellation verified');
    } finally {
      server?.closeAllConnections();
      await new Promise((resolve) => server ? server.close(resolve) : resolve());
      await host.close();
    }
    await assert.rejects(createEmbeddedOpenCode({ databasePath: ':memory:' }), /persistent database/);
  `;
  try {
    const result = await run(process.execPath, ['--input-type=module', '-e', source], {
      cwd: new URL('../../../..', import.meta.url), timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, TEST_DIRECTORY: directory,
        XDG_DATA_HOME: path.join(directory, 'data'), XDG_CACHE_HOME: path.join(directory, 'cache'),
        XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_STATE_HOME: path.join(directory, 'state'),
        OPENCODE_DB: '', OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG_DIR: path.join(directory, 'config'),
        APPDIR: path.join(directory, 'appimage'), LD_LIBRARY_PATH: path.join(directory, 'appimage/usr/lib'),
      },
    });
    expect(result.stdout).toContain('embedded 2.0.21 API, credentials, persistence, proxy and cancellation verified');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}, 70_000);
