import { describe, expect, it } from 'vitest';
import { createOpenCodeAuthStateRuntime } from './auth-state-runtime.js';
import { createHmrStateRuntime } from './hmr-state-runtime.js';

const createAuth = (initial = null) => {
  const state = { openCodeAuthPassword: initial, openCodeAuthSource: initial ? 'user-env' : null };
  const runtime = createOpenCodeAuthStateRuntime({ state, syncToHmrState() {} });
  return runtime;
};

describe('OpenCode auth state', () => {
  it('uses returned managed credentials in memory only and fails closed after clear', () => {
    const before = { ...process.env };
    const runtime = createAuth('external-only');
    runtime.setManagedOpenCodePassword('first-managed-password');
    expect(runtime.getOpenCodeAuthHeaders()).toEqual({ Authorization: `Basic ${Buffer.from('opencode:first-managed-password').toString('base64')}` });
    runtime.setManagedOpenCodePassword(null);
    expect(runtime.isOpenCodeConnectionSecure()).toBe(false);
    expect(() => runtime.getOpenCodeAuthHeaders()).toThrow('not ready');
    runtime.setManagedOpenCodePassword('second-managed-password');
    expect(runtime.isOpenCodeConnectionSecure()).toBe(true);
    expect(process.env).toEqual(before);
  });

  it('shares live auth across HMR consumers so an old process callback revokes new consumers', () => {
    const hmrState = { openCodeAuthPassword: null, openCodeAuthSource: null };
    const oldRuntime = createOpenCodeAuthStateRuntime({ state: hmrState, syncToHmrState() {} });
    oldRuntime.setManagedOpenCodePassword('first-generation');
    const reloadedRuntime = createOpenCodeAuthStateRuntime({ state: hmrState, syncToHmrState() {} });
    expect(reloadedRuntime.isOpenCodeConnectionSecure()).toBe(true);
    oldRuntime.setManagedOpenCodePassword(null);
    expect(reloadedRuntime.isOpenCodeConnectionSecure()).toBe(false);
    expect(() => reloadedRuntime.getOpenCodeAuthHeaders()).toThrow('not ready');
    reloadedRuntime.setManagedOpenCodePassword('replacement-generation');
    expect(oldRuntime.getOpenCodeAuthHeaders()).toEqual(reloadedRuntime.getOpenCodeAuthHeaders());
  });

  it('preserves external auth and external unauthenticated compatibility', () => {
    expect(createAuth().getOpenCodeAuthHeaders()).toEqual({});
    expect(createAuth('external').getOpenCodeAuthHeaders().Authorization).toBe(`Basic ${Buffer.from('opencode:external').toString('base64')}`);
  });

  it('does not restore an external env credential into a cleared managed HMR state', () => {
    const runtime = createHmrStateRuntime({});
    expect(runtime.resolveOpenCodeAuthFromState({
      hmrState: { openCodeAuthPassword: null, openCodeAuthSource: 'managed' },
      userProvidedOpenCodePassword: 'external-only',
    })).toEqual({ openCodeAuthPassword: null, openCodeAuthSource: 'managed' });
  });
});
