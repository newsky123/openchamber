import type { ChildProcess } from 'node:child_process';

export function stripOpenCodePasswordEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function waitForManagedOpenCodeHandshake(
  child: ChildProcess,
  options: { hostname: string; port: number; timeoutMs: number; signal?: AbortSignal },
): Promise<{ url: string; password: string }>;
