const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': ([A-Za-z_$][\w$]*): /;

/** Removes Electron's invoke wrapper without exposing schema diagnostics to the workspace UI. */
export function ipcErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim() === "") return fallback;

  const prefix = IPC_ERROR_PREFIX.exec(error.message);
  if (prefix !== null) {
    if (prefix[1] === "ZodError") return fallback;
    const message = error.message.slice(prefix[0].length).trim();
    return message === "" ? fallback : message;
  }

  if (error.name === "ZodError" || error.message.trimStart().startsWith("[")) return fallback;
  return error.message;
}
