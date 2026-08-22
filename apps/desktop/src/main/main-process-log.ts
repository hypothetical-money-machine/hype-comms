export type MainProcessLogWriter = (...values: unknown[]) => void;

interface ErrorEmittingStream {
  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * Electron development processes can outlive the terminal process that launched them. Once that
 * happens, stdout/stderr may emit EIO or EPIPE when a later reconnect attempts to log. Logging is
 * diagnostic only, so a broken log destination must never become an uncaught main-process error.
 */
export function protectMainProcessLogStreams(
  streams: readonly (ErrorEmittingStream | null | undefined)[],
): void {
  for (const stream of streams) {
    stream?.on("error", () => undefined);
  }
}

export function reportMainProcessError(
  message: string,
  error?: unknown,
  writer: MainProcessLogWriter = (...values) => console.error(...values),
): void {
  try {
    if (error === undefined) writer(message);
    else writer(message, error);
  } catch {
    // A closed console stream is not an application failure.
  }
}

export function reportMainProcessEvent(
  event: string,
  fields: Readonly<Record<string, string>> = {},
  writer: MainProcessLogWriter = (...values) => console.info(...values),
): void {
  try {
    writer(JSON.stringify({ event, ...fields }));
  } catch {
    // A closed console stream is not an application failure.
  }
}
