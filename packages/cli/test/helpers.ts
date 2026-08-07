import { PassThrough, Readable } from "node:stream";

import type { Runtime } from "../src/types.js";

export interface TestRuntime extends Runtime {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
}

export function testRuntime(input: {
  readonly homeDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly stdin?: string;
}): TestRuntime {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutContent = "";
  let stderrContent = "";
  stdout.on("data", (chunk: Buffer) => {
    stdoutContent += chunk.toString("utf8");
  });
  stderr.on("data", (chunk: Buffer) => {
    stderrContent += chunk.toString("utf8");
  });
  return {
    env: input.env ?? {},
    cwd: input.homeDirectory,
    homeDirectory: input.homeDirectory,
    fetch:
      input.fetch ??
      (async () => {
        throw new Error("Unexpected fetch");
      }),
    io: {
      stdin: Readable.from(input.stdin ?? ""),
      stdout,
      stderr,
      stdinIsTty: false,
    },
    now: Date.now,
    random: () => 0,
    stdoutText: () => stdoutContent,
    stderrText: () => stderrContent,
  };
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}
