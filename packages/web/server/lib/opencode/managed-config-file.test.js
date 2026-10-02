import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createManagedConfigRuntime, MANAGED_CONFIG_FILE_NAME } from './managed-config-file.js';

const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));
const createHarness = async ({ settings = {}, env = {}, memoryAvailable = true, fsPromises = fs } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-compiled-config-'));
  directories.push(dataDir);
  const current = { settings };
  const runtime = createManagedConfigRuntime({ fsPromises, path, dataDir, env,
    readSettings: async () => current.settings, isAgentMemoryAvailable: () => memoryAvailable });
  return { dataDir, current, runtime, read: async () => JSON.parse(await fs.readFile(runtime.filePath, 'utf8')) };
};

describe('compiled agent tool data-only config', () => {
  it('publishes settings with no plugin path, token or child callback environment', async () => {
    const { runtime, dataDir, read } = await createHarness();
    expect(await runtime.buildManagedChildEnv()).toEqual({ OPENCODE_CONFIG: path.join(dataDir, MANAGED_CONFIG_FILE_NAME) });
    expect(await read()).toEqual({ openchamber: { agentTools: { control: true, web: true, memory: false, notify: false, codeMode: false } } });
    expect(await fs.readdir(dataDir)).toEqual([MANAGED_CONFIG_FILE_NAME]);
  });
  it('updates only data flags while a child is running', async () => {
    const { runtime, current, read } = await createHarness();
    await runtime.buildManagedChildEnv();
    current.settings = { agentControlToolEnabled: false, agentWebToolEnabled: false, agentMemoryToolEnabled: true, agentNotifyToolEnabled: true, agentToolsCodeMode: true };
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: true });
    expect((await read()).openchamber.agentTools).toEqual({ control: false, web: false, memory: true, notify: true, codeMode: true });
  });
  it('does not enable unavailable memory', async () => {
    const { runtime, read } = await createHarness({ settings: { agentMemoryToolEnabled: true }, memoryAvailable: false });
    await runtime.buildManagedChildEnv();
    expect((await read()).openchamber.agentTools.memory).toBe(false);
  });
  it('preserves existing config and disabled dynamic plugin entries without loading them', async () => {
    const original = '{"model":"test/model","plugins":["custom-plugin"],"permission":[{"action":"openchamber","effect":"deny","resource":"*"}]}';
    const env = { OPENCODE_CONFIG: '/user/opencode.json', OPENCODE_CONFIG_CONTENT: original };
    const { runtime, dataDir } = await createHarness({ env });
    const child = await runtime.buildManagedChildEnv();
    const config = JSON.parse(child.OPENCODE_CONFIG_CONTENT);
    expect(config).toMatchObject(JSON.parse(original));
    expect(config.openchamber.agentTools.control).toBe(true);
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(original);
    expect(await fs.readdir(dataDir)).toEqual([]);
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: false, reason: 'external-config' });
  });
  it.each(['[]', 'null', '{broken', '{"openchamber":[]}', '{"openchamber":null}'])('rejects malformed fallback config %s without overwriting anything', async (content) => {
    const { runtime, dataDir } = await createHarness({ env: { OPENCODE_CONFIG: '/user/config', OPENCODE_CONFIG_CONTENT: content } });
    await expect(runtime.buildManagedChildEnv()).rejects.toThrow('valid JSON object');
    expect(await fs.readdir(dataDir)).toEqual([]);
  });
  it('preserves the previous settings file if an atomic replacement fails', async () => {
    let fail = false;
    const { runtime, current, read, dataDir } = await createHarness({ fsPromises: { ...fs, rename: async (...args) => {
      if (fail) throw new Error('Test write failure');
      return fs.rename(...args);
    } } });
    await runtime.buildManagedChildEnv();
    fail = true;
    current.settings = { agentControlToolEnabled: false };
    await expect(runtime.refreshManagedConfigFile()).rejects.toThrow('Test write failure');
    expect((await read()).openchamber.agentTools.control).toBe(true);
    expect(await fs.readdir(dataDir)).toEqual([MANAGED_CONFIG_FILE_NAME]);
  });
});
