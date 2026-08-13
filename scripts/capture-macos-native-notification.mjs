import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_ARGUMENT = "--hmm-macos-native-notification-evidence";
const EVIDENCE_DIRECTORY_ENV = "HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_DIRECTORY";
const RECORD_TIMEOUT_MS = 30_000;

export function parseMacosNativeNotificationCaptureArguments(arguments_, env = process.env) {
  let appBundle;
  let helperBundle;
  let artifactDirectory;
  for (const argument of arguments_) {
    if (argument.startsWith("--app=")) {
      if (appBundle !== undefined) throw new Error("--app may only be supplied once");
      appBundle = argument.slice("--app=".length);
      continue;
    }
    if (argument.startsWith("--helper=")) {
      if (helperBundle !== undefined) throw new Error("--helper may only be supplied once");
      helperBundle = argument.slice("--helper=".length);
      continue;
    }
    if (argument.startsWith("--artifacts=")) {
      if (artifactDirectory !== undefined) {
        throw new Error("--artifacts may only be supplied once");
      }
      artifactDirectory = argument.slice("--artifacts=".length);
      continue;
    }
    throw new Error(`Unknown macOS native notification capture argument: ${argument}`);
  }
  if (
    appBundle === undefined ||
    !path.isAbsolute(appBundle) ||
    path.extname(appBundle) !== ".app"
  ) {
    throw new Error("--app must be an absolute .app bundle path");
  }
  if (
    helperBundle === undefined ||
    !path.isAbsolute(helperBundle) ||
    path.extname(helperBundle) !== ".app"
  ) {
    throw new Error("--helper must be an absolute .app bundle path");
  }
  if (
    artifactDirectory === undefined ||
    !path.isAbsolute(artifactDirectory) ||
    artifactDirectory === path.parse(artifactDirectory).root
  ) {
    throw new Error("--artifacts must be a non-root absolute directory");
  }
  const runnerTemp = env.RUNNER_TEMP;
  if (runnerTemp !== undefined) {
    const relative = path.relative(path.resolve(runnerTemp), path.resolve(artifactDirectory));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("--artifacts must be a child of RUNNER_TEMP");
    }
  }
  return {
    appBundle: path.resolve(appBundle),
    helperBundle: path.resolve(helperBundle),
    artifactDirectory: path.resolve(artifactDirectory),
  };
}

function executableForBundle(appBundle) {
  return path.join(appBundle, "Contents", "MacOS", "hype-comms");
}

function executableForHelperBundle(helperBundle) {
  return path.join(helperBundle, "Contents", "MacOS", "hmm-native-notification-evidence");
}

async function runCommand(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (status.code !== 0) {
    const detail = `${stdout}\n${stderr}`.trim();
    throw new Error(
      `${command} failed with ${status.signal ?? `code ${String(status.code)}`}${
        detail === "" ? "" : `:\n${detail}`
      }`,
    );
  }
  return { stdout, stderr };
}

async function assertUnlockedConsole() {
  const { stdout } = await runCommand("/usr/sbin/ioreg", ["-n", "Root", "-d", "1"]);
  if (
    /"CGSSessionScreenIsLocked"\s*=\s*Yes/u.test(stdout) ||
    /"IOConsoleLocked"\s*=\s*Yes/u.test(stdout)
  ) {
    throw new Error("The macOS console is locked; unlock it before capturing GUI evidence");
  }
}

async function assertHelperPermissions(helperExecutable) {
  const { stdout } = await runCommand(helperExecutable, ["preflight"]);
  let state;
  try {
    state = JSON.parse(stdout);
  } catch {
    throw new Error("The macOS evidence helper returned an invalid permission record");
  }
  if (state?.accessibility !== true || state?.screenCapture !== true) {
    throw new Error("The macOS evidence helper does not own the required GUI permissions");
  }
}

async function waitForRecord(artifactDirectory, name, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? RECORD_TIMEOUT_MS);
  const recordPath = path.join(artifactDirectory, `${name}.json`);
  const failedPath = path.join(artifactDirectory, "failed.json");
  while (true) {
    try {
      return JSON.parse(await readFile(recordPath, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    try {
      await access(failedPath);
      throw new Error("The installed application reported native notification failure");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (name === "delivered") {
    throw new Error(
      "Timed out establishing installed Hype Comms notification authorization and delivery",
    );
  }
  throw new Error(`Timed out waiting for ${name}.json`);
}

async function captureScreen(helperExecutable, destination) {
  await runCommand(helperExecutable, ["capture", destination]);
  const details = await stat(destination);
  if (!details.isFile() || details.size < 10_000) {
    throw new Error(`macOS screenshot is missing or too small: ${destination}`);
  }
}

async function clickSyntheticNotification(helperExecutable) {
  const { stdout } = await runCommand(helperExecutable, ["click"]);
  const result = stdout.trim();
  if (result !== "notification-clicked") {
    throw new Error(`Could not activate the synthetic notification: ${result || "no result"}`);
  }
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("macOS native notification capture must run on macOS");
  }
  const { appBundle, helperBundle, artifactDirectory } =
    parseMacosNativeNotificationCaptureArguments(process.argv.slice(2));
  const executable = executableForBundle(appBundle);
  const helperExecutable = executableForHelperBundle(helperBundle);
  await access(executable);
  await access(helperExecutable);
  await assertUnlockedConsole();
  await assertHelperPermissions(helperExecutable);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(artifactDirectory, "automation.log"), "", {
    encoding: "utf8",
    mode: 0o600,
  });

  const child = spawn(executable, [EVIDENCE_ARGUMENT], {
    env: {
      ...process.env,
      [EVIDENCE_DIRECTORY_ENV]: artifactDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appLog = path.join(artifactDirectory, "application.log");
  child.stdout.pipe(createWriteStream(appLog, { flags: "a", mode: 0o600 }));
  child.stderr.pipe(createWriteStream(appLog, { flags: "a", mode: 0o600 }));

  try {
    const delivered = await waitForRecord(artifactDirectory, "delivered");
    if (delivered.version !== 1 || delivered.status !== "delivered") {
      throw new Error("Installed application wrote an invalid delivery record");
    }
    await captureScreen(
      helperExecutable,
      path.join(artifactDirectory, "macos-native-notification.png"),
    );

    await clickSyntheticNotification(helperExecutable);
    const clicked = await waitForRecord(artifactDirectory, "clicked", { timeoutMs: 30_000 });
    if (clicked.version !== 1 || clicked.status !== "clicked") {
      throw new Error("Installed application wrote an invalid click record");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await captureScreen(
      helperExecutable,
      path.join(artifactDirectory, "macos-native-notification-clicked.png"),
    );
  } finally {
    await terminate(child);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(
      `Could not capture macOS native notification evidence: ${
        error instanceof Error ? error.message : "Unknown error"
      }\n`,
    );
    process.exitCode = 1;
  });
}
