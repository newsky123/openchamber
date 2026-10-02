import type { ConnectionStatus, OpenCodeManager } from './opencode';

const API_URL_WAIT_TIMEOUT_MS = 30000;

export async function waitForApiUrl(
  manager: Pick<OpenCodeManager, 'getStatus' | 'getApiUrl' | 'onStatusChange'> | undefined,
  timeoutMs = API_URL_WAIT_TIMEOUT_MS,
): Promise<string | null> {
  if (!manager) {
    return null;
  }

  // Only hand out an API URL once OpenCode has actually passed its readiness
  // check. Keep the bridge gate independent of URL presence so alternate
  // manager implementations cannot expose an unready or stale endpoint.
  // Timeout also preserves this gate rather than releasing a partial startup.
  const readyUrl = (): string | null => {
    if (manager.getStatus() !== 'connected') {
      return null;
    }
    return manager.getApiUrl();
  };

  const initialUrl = readyUrl();
  if (initialUrl) {
    return initialUrl;
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let subscription: { dispose(): void } | null = null;
    let disposeAfterSubscribe = false;

    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (subscription) {
        subscription.dispose();
      } else {
        disposeAfterSubscribe = true;
      }
      resolve(value);
    };

    const handleStatusChange = (status: ConnectionStatus) => {
      // Permanent failure (CLI missing / spawn error) won't recover from holding
      // — fail fast instead of burning the full timeout, matching the web gate's
      // fast 503 for genuinely-down servers.
      if (status === 'error') {
        finish(null);
        return;
      }
      const nextUrl = readyUrl();
      if (nextUrl) {
        finish(nextUrl);
      }
    };

    // onStatusChange invokes the callback synchronously with the current status,
    // so this also covers an already-ready/already-errored manager.
    subscription = manager.onStatusChange(handleStatusChange);
    if (disposeAfterSubscribe) {
      subscription.dispose();
      return;
    }
    if (settled) {
      return;
    }

    timeoutId = setTimeout(() => {
      // An incomplete startup must never become an unauthenticated fallback.
      finish(readyUrl());
    }, timeoutMs);
  });
}
