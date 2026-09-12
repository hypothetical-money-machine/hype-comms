import { cliAdapterEnvelope } from "@hype-comms/contracts";
import { inspect } from "node:util";

import type { CliError } from "./errors.js";
import type { CliIo } from "./types.js";

function write(stream: CliIo["stdout"] | CliIo["stderr"], value: string): boolean {
  return stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

export function writeResult(io: CliIo, value: unknown, json: boolean): void {
  if (json) {
    write(
      io.stdout,
      JSON.stringify(
        io.adapterProtocol === undefined ? value : cliAdapterEnvelope("result", value),
      ),
    );
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

/** A watch position is accepted only when the writable confirms delivery of its NDJSON line. */
export class EventWriter {
  #failure: Error | undefined;
  readonly #pending = new Set<(error: Error) => void>();
  readonly #failed = (error: Error): void => {
    this.#failure = error;
    for (const reject of this.#pending) reject(error);
    this.#pending.clear();
  };
  readonly #closed = (): void => this.#failed(new Error("Event output closed"));
  constructor(
    private readonly stream: CliIo["stdout"],
    private readonly adapterProtocol?: 1,
  ) {
    stream.on("error", this.#failed);
    stream.on("close", this.#closed);
  }
  async write(value: unknown): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.stream.destroyed || this.stream.writableEnded)
      throw new Error("Event output is unavailable");
    await new Promise<void>((resolve, reject) => {
      this.#pending.add(reject);
      this.stream.write(
        `${JSON.stringify(this.adapterProtocol === undefined ? value : cliAdapterEnvelope("event", value))}\n`,
        (error) => {
          this.#pending.delete(reject);
          if (error != null) reject(error);
          else resolve();
        },
      );
    });
  }
  dispose(): void {
    this.stream.off("error", this.#failed);
    this.stream.off("close", this.#closed);
    this.#closed();
  }
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
