import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { stripOpenCodePasswordEnv, waitForManagedOpenCodeHandshake } from './managed-auth.js';

const password = 'a'.repeat(43);
const records = (url = 'http://127.0.0.1:45678') => `server listening on ${url}\nserver password ${password}\n`;
const fixture = (options = {}) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const ready = waitForManagedOpenCodeHandshake(child, { hostname: '127.0.0.1', port: 45678, timeoutMs: 100, ...options });
  return { child, ready };
};

describe('private managed OpenCode handshake', () => {
  it('strips both password variables after env composition without mutating its inputs', () => {
    const input = { PATH: '/bin', OPENCODE_PASSWORD: 'old', OPENCODE_SERVER_PASSWORD: 'older', OpenCode_Password: 'case', opencode_server_password: 'case2', PROVIDER_KEY: 'provider' };
    expect(stripOpenCodePasswordEnv(input)).toEqual({ PATH: '/bin', PROVIDER_KEY: 'provider' });
    expect(input.OPENCODE_PASSWORD).toBe('old');
  });

  it('accepts every byte split, including a split password, without waiting on stdout EOF', async () => {
    for (let index = 0; index <= records().length; index++) {
      const { child, ready } = fixture();
      child.stdout.write(records().slice(0, index));
      child.stdout.write(records().slice(index));
      expect(await ready).toEqual({ url: 'http://127.0.0.1:45678', password });
      expect(child.stdout.listenerCount('data')).toBe(0);
      child.stdout.end();
      child.stderr.end();
    }
  });

  it('accepts ordinary trailing output regardless of OS chunk coalescing', async () => {
    for (const suffix of ['initializing', 'log line\npartial line', 'x'.repeat(70000), `${records()}${password}`]) {
      const { child, ready } = fixture();
      child.stdout.write(records() + suffix);
      expect((await ready).url).toBe('http://127.0.0.1:45678');
    }
  });

  it('discards startup noise and drains both pipes after readiness', async () => {
    const { child, ready } = fixture();
    child.stderr.write(`diagnostic ${password}`);
    child.stdout.write(`unrelated initialization\n${records()}`);
    await ready;
    child.stdout.write(Buffer.alloc(128 * 1024, 'a'));
    child.stderr.write(Buffer.alloc(128 * 1024, 'a'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.stdout.readableLength).toBe(0);
    expect(child.stderr.readableLength).toBe(0);
  });

  for (const [name, output] of [
    ['wrong port', records('http://127.0.0.1:45679')],
    ['wrong host', records('http://example.com:45678')],
    ['userinfo', records('http://user:secret@127.0.0.1:45678')],
    ['path', records('http://127.0.0.1:45678/api')],
    ['fragment', records('http://127.0.0.1:45678/#secret')],
    ['password first', `server password ${password}\n${records()}`],
    ['duplicate URL', `server listening on http://127.0.0.1:45678\n${records()}`],
    ['interleaved output', `server listening on http://127.0.0.1:45678\nnoise\nserver password ${password}\n`],
    ['short password', records().replace(password, 'short')],
    ['oversized line', `${'x'.repeat(4097)}\n${records()}`],
    ['oversized startup', `${'x\n'.repeat(32769)}${records()}`],
  ]) {
    it(`fails closed on ${name} without including raw child output`, async () => {
      const { child, ready } = fixture();
      const result = ready.catch((error) => error);
      child.stdout.write(output);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(error.message.includes(password)).toBe(false);
      expect(error.message.includes(output)).toBe(false);
    });
  }

  for (const mode of ['timeout', 'exit', 'error', 'eof', 'abort']) {
    it(`discards partial secrets on ${mode}`, async () => {
      const controller = new AbortController();
      const { child, ready } = fixture({ signal: controller.signal, timeoutMs: 10 });
      const result = ready.catch((error) => error);
      child.stdout.write(`server listening on http://127.0.0.1:45678\nserver password ${password.slice(0, 19)}`);
      child.stderr.write(password);
      if (mode === 'exit') child.emit('exit', 1);
      if (mode === 'error') child.emit('error', new Error(password));
      if (mode === 'eof') child.stdout.end();
      if (mode === 'abort') controller.abort();
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(error.message.includes(password.slice(0, 19))).toBe(false);
    });
  }

  for (const [hostname, reported, connected] of [
    ['0.0.0.0', '0.0.0.0', '127.0.0.1'],
    ['::', '0.0.0.0', '127.0.0.1'],
    ['::1', '::1', '[::1]'],
    ['[::1]', '::1', '[::1]'],
  ]) {
    it(`normalizes the official CLI bind address for ${hostname}`, async () => {
      const { child, ready } = fixture({ hostname });
      child.stdout.write(records(`http://${reported}:45678`));
      expect((await ready).url).toBe(`http://${connected}:45678`);
    });
  }
});
