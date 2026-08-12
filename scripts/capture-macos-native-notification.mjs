import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_ARGUMENT = "--hmm-macos-native-notification-evidence";
const EVIDENCE_DIRECTORY_ENV = "HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_DIRECTORY";
const SYNTHETIC_BODY = "Synthetic direct message for native notification evidence";
const RECORD_TIMEOUT_MS = 120_000;

export function parseMacosNativeNotificationCaptureArguments(arguments_, env = process.env) {
  let appBundle;
  let artifactDirectory;
  for (const argument of arguments_) {
    if (argument.startsWith("--app=")) {
      if (appBundle !== undefined) throw new Error("--app may only be supplied once");
      appBundle = argument.slice("--app=".length);
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
    artifactDirectory: path.resolve(artifactDirectory),
  };
}

function executableForBundle(appBundle) {
  return path.join(appBundle, "Contents", "MacOS", "hype-comms");
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

async function runAppleScript(source, logPath) {
  try {
    const result = await runCommand("/usr/bin/osascript", [
      "-e",
      `with timeout of 5 seconds\n${source}\nend timeout`,
    ]);
    await appendFile(logPath, `${result.stdout.trim()}\n`, "utf8");
    return result.stdout.trim();
  } catch (error) {
    await appendFile(
      logPath,
      `${error instanceof Error ? error.message : "Unknown AppleScript failure"}\n`,
      "utf8",
    );
    return "failed";
  }
}

async function clickPermissionAllow(logPath) {
  return runAppleScript(
    `tell application "System Events"
  if UI elements enabled is false then return "accessibility-disabled"
  repeat with candidateProcess in application processes
    try
      repeat with candidateWindow in windows of candidateProcess
        repeat with candidateElement in entire contents of candidateWindow
          try
            if role of candidateElement is "AXButton" and name of candidateElement is "Allow" then
              click candidateElement
              return "permission-allowed"
            end if
          end try
        end repeat
      end repeat
    end try
  end repeat
end tell
return "permission-not-found"`,
    logPath,
  );
}

async function clickSyntheticNotification(logPath) {
  return runAppleScript(
    `tell application "System Events"
  if UI elements enabled is false then return "accessibility-disabled"
  if exists process "NotificationCenter" then
    tell process "NotificationCenter"
      repeat with candidateWindow in windows
        try
          set notificationText to (value of static texts of candidateWindow) as text
          if notificationText contains "${SYNTHETIC_BODY}" then
            try
              perform action "AXPress" of candidateWindow
            on error
              click candidateWindow
            end try
            return "notification-clicked"
          end if
        end try
      end repeat
    end tell
  end if
end tell
return "notification-not-found"`,
    logPath,
  );
}

async function waitForRecord(artifactDirectory, name, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? RECORD_TIMEOUT_MS);
  const recordPath = path.join(artifactDirectory, `${name}.json`);
  const failedPath = path.join(artifactDirectory, "failed.json");
  let nextPermissionAttempt = Date.now() + 2_000;
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
    if (options.permissionLog !== undefined && Date.now() >= nextPermissionAttempt) {
      await clickPermissionAllow(options.permissionLog);
      nextPermissionAttempt = Date.now() + 2_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${name}.json`);
}

async function captureScreen(destination) {
  await runCommand("/usr/sbin/screencapture", ["-x", destination]);
  const details = await stat(destination);
  if (!details.isFile() || details.size < 10_000) {
    throw new Error(`macOS screenshot is missing or too small: ${destination}`);
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
  const { appBundle, artifactDirectory } = parseMacosNativeNotificationCaptureArguments(
    process.argv.slice(2),
  );
  const executable = executableForBundle(appBundle);
  await access(executable);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const automationLog = path.join(artifactDirectory, "automation.log");
  await writeFile(automationLog, "", { encoding: "utf8", mode: 0o600 });

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
    const delivered = await waitForRecord(artifactDirectory, "delivered", {
      permissionLog: automationLog,
    });
    if (delivered.version !== 1 || delivered.status !== "delivered") {
      throw new Error("Installed application wrote an invalid delivery record");
    }
    await captureScreen(path.join(artifactDirectory, "macos-native-notification.png"));

    const clickResult = await clickSyntheticNotification(automationLog);
    if (clickResult !== "notification-clicked") {
      throw new Error(`Could not activate the synthetic notification: ${clickResult}`);
    }
    const clicked = await waitForRecord(artifactDirectory, "clicked", { timeoutMs: 30_000 });
    if (clicked.version !== 1 || clicked.status !== "clicked") {
      throw new Error("Installed application wrote an invalid click record");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await captureScreen(path.join(artifactDirectory, "macos-native-notification-clicked.png"));
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
