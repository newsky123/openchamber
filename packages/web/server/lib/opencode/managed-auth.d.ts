import type { ChildProcess } from 'node:child_process';

export function stripOpenCodePasswordEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function sanitizeManagedOpenCodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function waitForManagedOpenCodeHandshake(
  child: ChildProcess,
  options: { hostname: string; port: number; timeoutMs: number; signal?: AbortSignal; requireCompiledPluginsOnly?: boolean; agentToolsBootstrap?: 0 | 1 },
): Promise<{ url: string; password: string }>;
