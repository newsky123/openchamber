import type { ServerOptions } from '@opencode/server/options';
export const EMBEDDED_OPENCODE_ORIGIN: string;
export const EMBEDDED_OPENCODE_VERSION: string;
export const fetchOpenCode: typeof globalThis.fetch;
export type EmbeddedOpenCode = {
  readonly url: string;
  readonly pid: null;
  readonly exitCode: number | null;
  readonly fetch: typeof globalThis.fetch;
  close(): Promise<void>;
};
export function createEmbeddedOpenCode(options?: {
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  directory?: string;
  options?: ServerOptions;
}): Promise<EmbeddedOpenCode>;
