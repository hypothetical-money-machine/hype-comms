import { inspect } from "node:util";

import type { CliError } from "./errors.js";
import type { CliIo } from "./types.js";

function write(stream: CliIo["stdout"] | CliIo["stderr"], value: string): boolean {
  return stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

export function writeResult(io: CliIo, value: unknown, json: boolean): void {
  if (json) {
    write(io.stdout, JSON.stringify(value));
    return;
  }
  if (typeof value === "string") {
    write(io.stdout, value);
    return;
  }
  write(
    io.stdout,
    inspect(value, {
      colors: "isTTY" in io.stdout && io.stdout.isTTY === true,
      depth: null,
      compact: false,
      sorted: false,
    }),
  );
}

export function writeEvent(io: CliIo, value: unknown): boolean {
  return write(io.stdout, JSON.stringify(value));
}

export function writeDiagnostic(io: CliIo, value: string): void {
  write(io.stderr, value);
}

export function writeError(io: CliIo, error: CliError, json: boolean): void {
  if (json) {
    write(io.stderr, JSON.stringify(error.toJSON()));
    return;
  }
  write(io.stderr, `${error.code}: ${error.message}`);
  if (error.clientMessageId !== undefined) {
    write(io.stderr, `clientMessageId: ${error.clientMessageId}`);
  }
}
