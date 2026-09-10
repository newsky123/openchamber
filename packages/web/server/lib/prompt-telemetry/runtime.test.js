import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createPromptTelemetryRuntime } from './runtime.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const materialize = async (rawConfig = '{}') => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-prompt-telemetry-'));
  temporaryDirectories.push(dataDir);
  const runtime = createPromptTelemetryRuntime({ fsPromises: fs, path, dataDir });
  const prepared = await runtime.prepareManagedOpenCodeEnv(rawConfig);
  const pluginPath = path.join(dataDir, 'prompt-telemetry', 'openchamber-prompt-telemetry-plugin.js');
  const pluginModule = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}-${Math.random()}`);
  return { prepared, pluginPath, runtime, plugin: pluginModule.OpenChamberPromptTelemetryPlugin };
};

/** Records written so far, in append order, after the write queue drains. */
const readRecords = async (hooks, outputDirectory) => {
  await hooks.dispose();
  const files = await fs.readdir(outputDirectory).catch(() => []);
  const lines = await Promise.all(
    files.sort().map(async (file) => (await fs.readFile(path.join(outputDirectory, file), 'utf8')).trim()),
  );
  return lines
    .filter(Boolean)
    .flatMap((content) => content.split('\n'))
    .map((line) => JSON.parse(line));
};

const userMessages = (sessionID, messageID) => [
  { info: { id: messageID, sessionID, role: 'user' }, parts: [{ type: 'text', text: 'fix the parser' }] },
];

const paramsInput = (sessionID, messageID) => ({
  sessionID,
  agent: 'build',
  model: { id: 'test-model', providerID: 'test-provider' },
  provider: { id: 'test-provider' },
  message: { id: messageID },
});

const paramsOutput = (options = {}) => ({
  temperature: 0.2,
  topP: 1,
  topK: 40,
  maxOutputTokens: 8000,
  options,
});

describe('managed prompt telemetry runtime', () => {
  it('materializes the plugin and preserves existing plugin entries', async () => {
    const { prepared, pluginPath } = await materialize('{ "plugin": ["file:///existing.js"], "model": "test/model" }');

    const config = JSON.parse(prepared.OPENCODE_CONFIG_CONTENT);
    expect(config.model).toBe('test/model');
    expect(config.plugin).toEqual(['file:///existing.js', pathToFileURL(pluginPath).href]);
  });

  it('writes one request record carrying the system prompt and messages of that call', async () => {
    const { plugin, runtime } = await materialize();
    const hooks = await plugin({ directory: '/work/project' });
    const messages = userMessages('ses_1', 'msg_1');

    await hooks['experimental.chat.messages.transform']({}, { messages });
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_1', model: { id: 'test-model' } },
      { system: ['You are OpenCode.', 'Project rules.'] },
    );
    await hooks['chat.params'](paramsInput('ses_1', 'msg_1'), paramsOutput());

    const records = await readRecords(hooks, runtime.outputDirectory);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      type: 'request',
      directory: '/work/project',
      sessionID: 'ses_1',
      sequence: 1,
      userMessageID: 'msg_1',
      agent: 'build',
      providerID: 'test-provider',
      modelID: 'test-model',
      system: ['You are OpenCode.', 'Project rules.'],
      lastMessageID: 'msg_1',
    });
    expect(records[0].messages).toEqual(messages);
    expect(records[0].params.maxOutputTokens).toBe(8000);
  });

  it('numbers calls per session so the steps of one turn stay ordered', async () => {
    const { plugin, runtime } = await materialize();
    const hooks = await plugin({ directory: '/work/project' });

    await hooks['chat.params'](paramsInput('ses_1', 'msg_1'), paramsOutput());
    await hooks['chat.params'](paramsInput('ses_1', 'msg_1'), paramsOutput());
    await hooks['chat.params'](paramsInput('ses_2', 'msg_9'), paramsOutput());

    const records = await readRecords(hooks, runtime.outputDirectory);
    expect(records.map((record) => [record.sessionID, record.sequence])).toEqual([
      ['ses_1', 1],
      ['ses_1', 2],
      ['ses_2', 1],
    ]);
  });

  it('records a call that carried no message transform rather than dropping it', async () => {
    const { plugin, runtime } = await materialize();
    const hooks = await plugin({ directory: '/work/project' });

    await hooks['experimental.chat.system.transform']({ sessionID: 'ses_1' }, { system: ['Summarize.'] });
    await hooks['chat.params'](paramsInput('ses_1', 'msg_1'), paramsOutput());

    const records = await readRecords(hooks, runtime.outputDirectory);
    expect(records).toHaveLength(1);
    expect(records[0].messages).toBeNull();
    expect(records[0].messagesCapturedAt).toBeNull();
    expect(records[0].system).toEqual(['Summarize.']);
  });

  it('redacts credentials merged into provider options', async () => {
    const { plugin, runtime } = await materialize();
    const hooks = await plugin({ directory: '/work/project' });

    await hooks['chat.params'](
      paramsInput('ses_1', 'msg_1'),
      paramsOutput({
        apiKey: 'sk-live-secret',
        baseURL: 'https://proxy.example.com/v1',
        nested: { authorization: 'Bearer abc', reasoningEffort: 'high' },
      }),
    );

    const [record] = await readRecords(hooks, runtime.outputDirectory);
    expect(record.params.options).toEqual({
      apiKey: '[redacted]',
      baseURL: 'https://proxy.example.com/v1',
      nested: { authorization: '[redacted]', reasoningEffort: 'high' },
    });
  });

  it('writes a tool schema once until it changes', async () => {
    const { plugin, runtime } = await materialize();
    const hooks = await plugin({ directory: '/work/project' });
    const parameters = { type: 'object', properties: { path: { type: 'string' } } };

    await hooks['tool.definition']({ toolID: 'read' }, { description: 'Read a file', parameters });
    await hooks['tool.definition']({ toolID: 'read' }, { description: 'Read a file', parameters });
    await hooks['tool.definition']({ toolID: 'read' }, { description: 'Read a file, maybe', parameters });

    const records = await readRecords(hooks, runtime.outputDirectory);
    expect(records.map((record) => record.description)).toEqual(['Read a file', 'Read a file, maybe']);
    expect(records[0]).toMatchObject({ type: 'tool', toolID: 'read', parameters });
    expect(records[0].hash).not.toBe(records[1].hash);
  });

  it('swallows malformed hook payloads instead of failing the turn', async () => {
    const { plugin, runtime } = await materialize();
    const hooks = await plugin({ directory: '/work/project' });

    await expect(hooks['experimental.chat.messages.transform'](undefined, undefined)).resolves.toBeUndefined();
    await expect(hooks['experimental.chat.system.transform'](undefined, undefined)).resolves.toBeUndefined();
    await expect(hooks['chat.params'](undefined, undefined)).resolves.toBeUndefined();
    await expect(hooks['tool.definition'](undefined, undefined)).resolves.toBeUndefined();

    expect(await readRecords(hooks, runtime.outputDirectory)).toEqual([]);
  });
});
