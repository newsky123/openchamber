import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

import { registerPluginRoutes } from './plugin-routes.js';

const unavailable = {
  error: 'Dynamic OpenCode plugin configuration is unavailable.',
  code: 'dynamic_plugins_unavailable',
};
const requests = [
  ['get', '/api/config/plugins'],
  ['get', '/api/config/plugins/registry?specs=example-plugin&refresh=true'],
  ['get', '/api/config/plugins/entry/existing'],
  ['post', '/api/config/plugins/entry'],
  ['patch', '/api/config/plugins/entry/existing'],
  ['delete', '/api/config/plugins/entry/existing'],
  ['get', '/api/config/plugins/file/existing'],
  ['post', '/api/config/plugins/file'],
  ['put', '/api/config/plugins/file/existing'],
  ['delete', '/api/config/plugins/file/existing'],
  ['post', '/api/config/plugins/future-operation'],
];

describe('retired OpenCode plugin configuration routes', () => {
  let app;
  let root;
  let originals;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-plugin-routes-'));
    originals = new Map();
    for (const directory of [path.join(root, 'user'), path.join(root, 'project', '.opencode')]) {
      fs.mkdirSync(path.join(directory, 'plugins'), { recursive: true });
      originals.set(path.join(directory, 'opencode.jsonc'), '// Keep user config as written\n{"plugin":["legacy"],"plugins":["existing"],"agents":{}}\n');
      originals.set(path.join(directory, 'plugins', 'existing.ts'), 'export default { id: "existing" };\n');
    }
    for (const [file, contents] of originals) fs.writeFileSync(file, contents);

    app = express();
    app.use(express.json());
    registerPluginRoutes(app);
    app.use((_req, res) => res.status(418).json({ error: 'proxy fallthrough' }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each(requests)('%s %s is unavailable and preserves existing files', async (method, route) => {
    const response = await request(app)[method](route)
      .query({ directory: path.join(root, 'project') })
      .send({ scope: 'project', spec: 'replacement', fileName: 'existing.ts', content: 'replacement' })
      .expect(501);

    expect(response.body).toEqual(unavailable);
    for (const [file, contents] of originals) expect(fs.readFileSync(file, 'utf8')).toBe(contents);
    expect(fs.readdirSync(path.join(root, 'project', '.opencode', 'plugins'))).toEqual(['existing.ts']);
  });

  test('matches only the retired route family', async () => {
    await request(app).get('/api/config/mcp').expect(418);
    await request(app).get('/api/config/plugins-other').expect(418);
  });
});
