import { readFile } from "node:fs/promises";

import { UsageError } from "./errors.js";
import type { CliIo } from "./types.js";

const MAX_INPUT_BYTES = 64 * 1_024;

export async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    total += buffer.length;
    if (total > MAX_INPUT_BYTES) throw new UsageError("Input is too large", "INPUT_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface RawReadable {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  setEncoding(encoding: BufferEncoding): void;
  on(event: "data", listener: (chunk: string) => void): void;
  on(event: "end" | "close" | "error", listener: () => void): void;
  off(event: "data", listener: (chunk: string) => void): void;
  off(event: "end" | "close" | "error", listener: () => void): void;
}

async function hiddenPrompt(io: CliIo, prompt: string): Promise<string> {
  const input = io.stdin as RawReadable;
  if (typeof input.setRawMode !== "function") {
    throw new UsageError(
      "A private prompt is unavailable; pipe the credential through stdin",
      "PRIVATE_INPUT_REQUIRED",
    );
  }
  io.stderr.write(prompt);
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onClosed);
      input.off("close", onClosed);
      input.off("error", onFailed);
      input.setRawMode?.(false);
      input.pause();
      io.stderr.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    // Without these, EOF (Ctrl-D) or a stream error leaves the promise pending forever and the
    // terminal stuck in raw mode, because only `data` ever settles the prompt.
    const onClosed = (): void => {
      finish(new UsageError("Credential input ended before a value was entered", "EMPTY_INPUT"));
    };
    const onFailed = (): void => {
      finish(new UsageError("Credential input could not be read", "PRIVATE_INPUT_REQUIRED"));
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new UsageError("Credential input was cancelled", "CANCELLED"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (character >= " " && value.length < MAX_INPUT_BYTES) {
          value += character;
        }
      }
    };
    input.on("data", onData);
    input.on("end", onClosed);
    input.on("close", onClosed);
    input.on("error", onFailed);
  });
}

export async function readPrivateValue(io: CliIo, label: string): Promise<string> {
  const value = io.stdinIsTty
    ? await hiddenPrompt(io, `${label}: `)
    : (await readStream(io.stdin)).trim();
  if (value.length === 0) throw new UsageError(`${label} was empty`, "EMPTY_INPUT");
  return value;
}

export async function messageBody(input: {
  readonly io: CliIo;
  readonly inline?: string;
  readonly file?: string;
}): Promise<string> {
  const sources = Number(input.inline !== undefined) + Number(input.file !== undefined);
  if (sources > 1) {
    throw new UsageError("Provide the message as text, --file, or stdin, not more than one");
  }
  if (input.inline !== undefined) return input.inline;
  if (input.file !== undefined) {
    try {
      const info = await readFile(input.file);
      if (info.length > MAX_INPUT_BYTES) throw new UsageError("Message file is too large");
      return info.toString("utf8");
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError("The message file could not be read", "FILE_READ_FAILED");
    }
  }
  if (input.io.stdinIsTty) {
    throw new UsageError("Provide message text, --file, or pipe the body through stdin");
  }
  return readStream(input.io.stdin);
}
