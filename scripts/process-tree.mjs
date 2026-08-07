import { spawn } from "node:child_process";

function hasExited(child) {
  return child.exitCode !== null && child.exitCode !== undefined;
}

function isMissingProcess(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

async function waitForTaskkill(taskkill) {
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    taskkill.once("close", finish);
    taskkill.once("error", finish);
  });
}

/**
 * Signal a detached POSIX group or an entire Windows process tree. On Windows taskkill is needed
 * because terminating npm does not necessarily terminate electron-vite and its Electron child.
 */
export async function signalProcessTree(
  child,
  signal,
  { platform = process.platform, spawnProcess = spawn, killProcess = process.kill } = {},
) {
  if (child === null || typeof child !== "object" || hasExited(child)) return;
  if (child.pid === undefined) {
    if (typeof child.kill === "function") child.kill(signal);
    return;
  }

  if (platform !== "win32") {
    try {
      killProcess(-child.pid, signal);
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
    }
    return;
  }

  const taskkill = spawnProcess(
    "taskkill",
    ["/pid", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
    { stdio: "ignore", windowsHide: true },
  );
  await waitForTaskkill(taskkill);
}
