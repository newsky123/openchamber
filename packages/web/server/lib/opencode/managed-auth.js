import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// OpenCode's generated password is returned on its private stdout pipe. Neither
// stream is a log: even failures must never retain or forward raw child output.
const MAX_STARTUP_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4096;
const URL_PREFIX = 'server listening on ';
const PASSWORD_PREFIX = 'server password ';

export const stripOpenCodePasswordEnv = (env) => Object.fromEntries(
  Object.entries(env).filter(([key]) => !['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'].includes(key.toUpperCase())),
);

export const waitForManagedOpenCodeHandshake = (child, { hostname, port, timeoutMs, signal }) => {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? Promise.resolve([{ address: host }]) : lookup(host, { all: true });
  return new Promise((resolve, reject) => {
    let pending = '';
    let bytes = 0;
    let announcedUrl = null;
    let password = null;
    let settled = false;
    let expectedUrls = null;
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.off('data', onData);
      child.stdout?.off('end', onEnd);
      child.off('exit', onExit);
      child.off('error', onError);
      // Drain private pipes for the full process lifetime, including trailing
      // startup lines and errors. There is deliberately no diagnostic ring.
      child.stdout?.resume();
      child.stderr?.resume();
      pending = '';
      if (error) reject(error);
      else resolve({ url, password });
      password = null;
    };
    const invalid = () => finish(new Error('OpenCode private startup handshake is invalid. No credentials were accepted.'));
    const complete = () => {
      if (!password || !expectedUrls || settled) return;
      const url = expectedUrls.get(announcedUrl);
      if (!url) return invalid();
      finish(null, url);
    };
    const onData = (chunk) => {
      // The protocol ends at the first complete pair. Bounds only cover bytes
      // up to that boundary, so OS coalescing with later logs changes nothing.
      if (settled || password) return;
      const data = chunk.toString();
      let offset = 0;
      while (offset < data.length) {
        const end = data.indexOf('\n', offset);
        const fragment = data.slice(offset, end === -1 ? data.length : end);
        bytes += Buffer.byteLength(fragment) + (end === -1 ? 0 : 1);
        if (bytes > MAX_STARTUP_BYTES || Buffer.byteLength(pending) + Buffer.byteLength(fragment) > MAX_LINE_BYTES) return invalid();
        pending += fragment;
        if (end === -1) return;
        const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
        pending = '';
        offset = end + 1;
        if (line.startsWith(URL_PREFIX)) {
          if (announcedUrl) return invalid();
          announcedUrl = line.slice(URL_PREFIX.length);
          if (expectedUrls && !expectedUrls.has(announcedUrl)) return invalid();
        } else if (line.startsWith(PASSWORD_PREFIX)) {
          if (!announcedUrl || !/^server password [A-Za-z0-9_-]{43}$/.test(line)) return invalid();
          password = line.slice(PASSWORD_PREFIX.length);
          complete();
          return;
        } else if (announcedUrl) {
          // The CLI emits these two records consecutively after server startup.
          return invalid();
        }
      }
    };
    const onExit = () => finish(new Error('OpenCode exited before its private startup handshake completed.'));
    const onEnd = () => finish(new Error('OpenCode closed its private startup pipe before the handshake completed.'));
    const onError = () => finish(new Error('OpenCode process could not start. Check the configured CLI executable.'));
    const onAbort = () => finish(new Error('OpenCode startup cancelled.'));
    const timer = setTimeout(() => finish(new Error(`Timeout waiting for OpenCode private startup handshake after ${timeoutMs}ms.`)), timeoutMs);
    child.stdout?.on('data', onData);
    child.stdout?.once('end', onEnd);
    child.stderr?.resume();
    child.once('exit', onExit);
    child.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    void addresses.then((resolved) => {
      if (settled) return;
      expectedUrls = new Map(resolved.map(({ address }) => {
        // OpenCode 2.0.20/21's Effect formatter prints the actual bind address,
        // maps :: to 0.0.0.0, and omits IPv6 brackets. Match that exact record,
        // then construct our own safe connection URL instead of using stdout.
        const reported = address === '::' ? '0.0.0.0' : address;
        const connect = reported === '0.0.0.0' ? '127.0.0.1' : reported;
        const formatted = connect.includes(':') ? `[${connect}]` : connect;
        return [`http://${reported}:${port}`, `http://${formatted}:${port}`];
      }));
      if (announcedUrl && !expectedUrls.has(announcedUrl)) return invalid();
      complete();
    }, () => finish(new Error('Could not resolve the configured OpenCode bind address.')));
    if (signal?.aborted) onAbort();
    else if (child.exitCode != null || child.signalCode != null) onExit();
  });
};
