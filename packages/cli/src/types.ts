import type { Readable, Writable } from "node:stream";

export interface CliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly stdinIsTty: boolean;
}

export interface Runtime {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly fetch: typeof globalThis.fetch;
  readonly io: CliIo;
  readonly now: () => number;
  readonly random: () => number;
}

export interface GlobalOptions {
  readonly json: boolean;
  readonly profile?: string;
  readonly apiOrigin?: string;
  readonly timeoutMs: number;
}

export interface CommandContext {
  readonly runtime: Runtime;
  readonly options: GlobalOptions;
}
