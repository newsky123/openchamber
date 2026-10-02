import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAgentToolRuntime } from './runtime.js';
import { createAgentToolCatalog } from './catalog.js';
import { OPENCHAMBER_AGENT_TOOL_ACTIONS, OPENCHAMBER_WEB_ACTIONS, OPENCHAMBER_MEMORY_ACTIONS, OPENCHAMBER_NOTIFY_ACTIONS } from '../openchamber-control/actions.js';

const createRuntime = (overrides = {}) => {
  const current = { settings: { agentMemoryToolEnabled: true, agentNotifyToolEnabled: true } };
  const executeAction = vi.fn(async () => ({ done: true }));
  const runtime = createAgentToolRuntime({
    crypto, getActivePort: () => 3901, executeAction,
    resolveSessionDirectory: async () => '/work/project',
    readSettings: async () => current.settings, isAgentMemoryAvailable: () => true,
    ...overrides,
  });
  const app = express();
  runtime.registerRoutes(app, express);
  const call = (input = { action: 'projects.list' }, tool = 'openchamber', sessionID = 'ses_current') => ({ input, tool, sessionID });
  const post = (bootstrap, body = call()) => request(app).post('/api/openchamber/agent-tool')
    .set('Host', new URL(bootstrap.payload.url).host)
    .set('Authorization', `Bearer ${bootstrap.payload.token}`).send(body);
  return { runtime, app, current, executeAction, call, post };
};

describe('compiled agent tool catalog', () => {
  it('carries the same four tool ids, action titles and parameter groups as data only', () => {
    const catalog = createAgentToolCatalog();
    expect(catalog.map(({ name }) => name)).toEqual(['openchamber', 'openchamber_web', 'openchamber_memory', 'openchamber_notify']);
    expect(catalog.map(({ actionTitles }) => Object.keys(actionTitles).length)).toEqual([14, 10, 4, 1]);
    for (const tool of catalog) {
      expect(tool.input.properties.action).not.toHaveProperty('enum');
      expect(tool.input.properties.action.oneOf.every(({ description }) => description)).toBe(true);
      expect(tool.input.additionalProperties).toBe(false);
    }
    expect(catalog[0].input.properties).not.toHaveProperty('url');
    expect(catalog[1].input.properties).not.toHaveProperty('path');
    expect(catalog[2].input.properties.title.description).toContain('memory');
  });

  it('does not generate files or put credentials in environment/config output', () => {
    const { runtime } = createRuntime();
    const bootstrap = runtime.createBootstrap();
    expect(bootstrap.payload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bootstrap.payload.version).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(bootstrap.payload))).toBeLessThan(64 * 1024);
    expect(runtime).not.toHaveProperty('materializePlugin');
    expect(runtime).not.toHaveProperty('createChildEnv');
    expect(JSON.stringify(bootstrap.payload.catalog)).not.toContain(bootstrap.payload.token);
  });
});

describe('compiled agent action boundary', () => {
  it.each([
    ...OPENCHAMBER_AGENT_TOOL_ACTIONS.map((action) => ['openchamber', action]),
    ...OPENCHAMBER_WEB_ACTIONS.map((action) => ['openchamber_web', action]),
    ...OPENCHAMBER_MEMORY_ACTIONS.map((action) => ['openchamber_memory', action]),
    ...OPENCHAMBER_NOTIFY_ACTIONS.map((action) => ['openchamber_notify', action]),
  ])('preserves %s / %s delegation and authoritative caller context', async (tool, action) => {
    const { runtime, executeAction, call } = createRuntime();
    expect(await runtime.execute(call({ action }, tool))).toMatchObject({ schemaVersion: 1, action, ok: true });
    expect(executeAction).toHaveBeenCalledWith(action, { action }, '/work/project', { contextSessionId: 'ses_current' });
  });

  it.each([
    ['openchamber', 'session.delete'], ['openchamber', 'schedule.status'],
    ['openchamber_memory', 'browser.open'], ['unknown', 'projects.list'],
  ])('refuses action outside %s: %s', async (tool, action) => {
    const { runtime, executeAction, call } = createRuntime();
    expect(await runtime.execute(call({ action }, tool))).toMatchObject({ ok: false });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('resolves a bare action only within the calling tool', async () => {
    const { runtime, call } = createRuntime();
    expect(await runtime.execute(call({ action: 'read', title: 'convention' }, 'openchamber_memory'))).toMatchObject({ action: 'memory.read', ok: true });
  });

  it.each(['contextDirectory', 'contextSessionId', 'confirmed', 'approvalToken'])('refuses caller-provided %s authority', async (field) => {
    const { runtime, executeAction, call } = createRuntime();
    expect(await runtime.execute({ ...call(), [field]: '/other' })).toMatchObject({ ok: false });
    expect(await runtime.execute(call({ action: 'projects.list', [field]: '/other' }))).toMatchObject({ ok: false });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('fails closed when the caller session or its directory is missing', async () => {
    const { runtime, executeAction, call } = createRuntime({ resolveSessionDirectory: async () => null });
    expect(await runtime.execute(call())).toMatchObject({ ok: false });
    expect(await runtime.execute(call({ action: 'projects.list' }, 'openchamber', ''))).toMatchObject({ ok: false });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it.each([
    ['openchamber', 'projects.list', 'agentControlToolEnabled'],
    ['openchamber_web', 'browser.snapshot', 'agentWebToolEnabled'],
    ['openchamber_memory', 'memory.list', 'agentMemoryToolEnabled'],
    ['openchamber_notify', 'notify.send', 'agentNotifyToolEnabled'],
  ])('refuses disabled %s even with a stale compiled catalog', async (tool, action, setting) => {
    const { runtime, current, executeAction, call } = createRuntime();
    current.settings[setting] = false;
    expect(await runtime.execute(call({ action }, tool))).toMatchObject({ ok: false });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('fails closed on settings read failure and unavailable memory', async () => {
    const missing = createRuntime({ readSettings: async () => { throw new Error('unreadable'); } });
    expect(await missing.runtime.execute(missing.call())).toMatchObject({ ok: false });
    const memory = createRuntime({ isAgentMemoryAvailable: () => false });
    expect(await memory.runtime.execute(memory.call({ action: 'memory.list' }, 'openchamber_memory'))).toMatchObject({ ok: false });
  });

  it('preserves partial failure details without claiming success', async () => {
    const error = Object.assign(new Error('Prompt failed'), { partial: true, partialAction: 'session.create', sessionId: 'new', directory: '/work/project' });
    const { runtime, call } = createRuntime({ executeAction: async () => { throw error; } });
    expect(await runtime.execute(call({ action: 'session.create' }))).toMatchObject({ ok: false, data: { partial: true, sessionId: 'new' }, error: { message: 'Prompt failed' } });
  });
});

describe('private callback authentication and lifecycle', () => {
  it('requires current capability and blocks wrong host/origin and old generations', async () => {
    const { runtime, post, app, call } = createRuntime();
    const first = runtime.createBootstrap();
    await request(app).post('/api/openchamber/agent-tool').send(call()).expect(401);
    await post(first).expect(200);
    await post(first).set('Host', 'evil.invalid').expect(401);
    await post(first).set('Origin', 'https://evil.invalid').expect(401);
    await post(first).set('Authorization', 'Bearer wrong').expect(401);
    const next = runtime.createBootstrap();
    expect(next.payload.token).not.toBe(first.payload.token);
    first.revoke();
    await post(first).expect(401);
    await post(next).expect(200);
    next.revoke();
    await post(next).expect(401);
  });

  it('retains the credential through HMR without putting it in the environment', async () => {
    const credentialState = { token: null, authority: null };
    const first = createRuntime({ credentialState });
    const bootstrap = first.runtime.createBootstrap();
    const replacement = createRuntime({ credentialState });
    await replacement.post(bootstrap).expect(200);
    bootstrap.revoke();
    await replacement.post(bootstrap).expect(401);
  });

  it.each([
    ['0.0.0.0', '127.0.0.1'], ['::', '127.0.0.1'], ['127.0.0.1', '127.0.0.1'],
    ['100.100.0.3', '100.100.0.3'], ['fd7a:115c::3', '[fd7a:115c::3]'],
  ])('keeps the concrete bind callback for %s', (bound, expected) => {
    const { runtime } = createRuntime({ getActiveHost: () => bound });
    expect(runtime.createBootstrap().payload.url).toBe(`http://${expected}:3901/api/openchamber/agent-tool`);
  });

  it('aborts only the requested session, and rotation cancels remaining requests', async () => {
    const executeAction = vi.fn(async (_action, _input, _directory, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    }));
    const { runtime, post, call } = createRuntime({ executeAction });
    const bootstrap = runtime.createBootstrap();
    const first = post(bootstrap, call()).then((response) => response);
    const other = post(bootstrap, call({ action: 'projects.list' }, 'openchamber', 'ses_other')).then((response) => response);
    await vi.waitFor(() => expect(executeAction).toHaveBeenCalledTimes(2));
    expect(runtime.abortSession('ses_current')).toBe(1);
    expect((await first).body.ok).toBe(false);
    runtime.createBootstrap();
    expect((await other).body.ok).toBe(false);
    expect(runtime.abortSession('ses_other')).toBe(0);
  });
});
