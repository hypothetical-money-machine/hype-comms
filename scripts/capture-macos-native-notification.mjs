import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
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

async function readConsoleSession() {
  const userResult = await runCommand("/usr/bin/stat", ["-f", "%Su", "/dev/console"]);
  const user = userResult.stdout.trim();
  if (!/^[a-zA-Z0-9._-]+$/u.test(user) || user === "root" || user === "loginwindow") {
    throw new Error(`No safe logged-in macOS console user is available: ${user || "none"}`);
  }
  const uidResult = await runCommand("/usr/bin/id", ["-u", user]);
  const uid = uidResult.stdout.trim();
  if (!/^\d+$/u.test(uid) || uid === "0") {
    throw new Error(`The logged-in macOS console user has an invalid uid: ${uid || "none"}`);
  }
  return { user, uid };
}

function escapePlistString(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function runInConsoleLaunchAgent(command, arguments_) {
  const { uid } = await readConsoleSession();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "hmm-notification-agent-"));
  const identifier = `com.hypemm.hmm-chat.notification-evidence.${process.pid}.${randomUUID()}`;
  const helperPath = path.join(temporaryDirectory, "run.mjs");
  const plistPath = path.join(temporaryDirectory, "agent.plist");
  const stdoutPath = path.join(temporaryDirectory, "stdout.log");
  const stderrPath = path.join(temporaryDirectory, "stderr.log");
  const statusPath = path.join(temporaryDirectory, "status.txt");
  const helperSource = `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const result = spawnSync(process.argv[2], process.argv.slice(3), { encoding: "utf8" });
writeFileSync(${JSON.stringify(stdoutPath)}, result.stdout ?? "", { encoding: "utf8", mode: 0o600 });
writeFileSync(${JSON.stringify(stderrPath)}, result.stderr ?? "", { encoding: "utf8", mode: 0o600 });
writeFileSync(${JSON.stringify(statusPath)}, String(result.status ?? 1), { encoding: "utf8", mode: 0o600 });
`;
  const programArguments = [process.execPath, helperPath, command, ...arguments_]
    .map((value) => `    <string>${escapePlistString(value)}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlistString(identifier)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
  await writeFile(helperPath, helperSource, { encoding: "utf8", mode: 0o600 });
  await writeFile(plistPath, plist, { encoding: "utf8", mode: 0o600 });

  let bootstrapped = false;
  try {
    await runCommand("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    bootstrapped = true;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const status = Number.parseInt((await readFile(statusPath, "utf8")).trim(), 10);
        const stdout = await readFile(stdoutPath, "utf8");
        const stderr = await readFile(stderrPath, "utf8");
        if (status !== 0) {
          throw new Error(
            `${command} failed with code ${String(status)}${stderr.trim() === "" ? "" : `:\n${stderr.trim()}`}`,
          );
        }
        return { stdout, stderr };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${command} in the macOS GUI launch domain`);
  } finally {
    if (bootstrapped) {
      try {
        await runCommand("/bin/launchctl", ["bootout", `gui/${uid}/${identifier}`]);
      } catch {
        // The one-shot agent may already have exited and been removed.
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function runAppleScript(source, logPath) {
  const arguments_ = ["-e", `with timeout of 5 seconds\n${source}\nend timeout`];
  const semanticMisses = new Set([
    "accessibility-disabled",
    "notification-not-found",
    "permission-not-found",
  ]);
  let directDetail;
  try {
    const result = await runCommand("/usr/bin/osascript", arguments_);
    const value = result.stdout.trim();
    if (!semanticMisses.has(value)) {
      await appendFile(logPath, `${value}\n`, "utf8");
      return value;
    }
    directDetail = `Direct AppleScript returned ${value}.`;
  } catch (directError) {
    directDetail = `Direct AppleScript: ${directError instanceof Error ? directError.message : "unknown failure"}`;
  }
  try {
    const result = await runInConsoleLaunchAgent("/usr/bin/osascript", arguments_);
    const value = result.stdout.trim();
    await appendFile(
      logPath,
      `${directDetail}\nLaunchAgent AppleScript returned ${value}.\n`,
      "utf8",
    );
    return value;
  } catch (agentError) {
    await appendFile(
      logPath,
      `${directDetail}\nLaunchAgent AppleScript: ${agentError instanceof Error ? agentError.message : "unknown failure"}\n`,
      "utf8",
    );
    return "failed";
  }
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
  throw new Error(`Timed out waiting for ${name}.json`);
}

async function appendDisplayDiagnostics(logPath) {
  const commands = [
    ["/usr/bin/stat", ["-f", "console-user=%Su", "/dev/console"]],
    ["/usr/sbin/system_profiler", ["SPDisplaysDataType", "-detailLevel", "mini"]],
  ];
  for (const [command, arguments_] of commands) {
    try {
      const result = await runCommand(command, arguments_);
      await appendFile(logPath, `${result.stdout.trim()}\n${result.stderr.trim()}\n`, "utf8");
    } catch (error) {
      await appendFile(
        logPath,
        `${error instanceof Error ? error.message : "Unknown display diagnostic failure"}\n`,
        "utf8",
      );
    }
  }
}

async function captureScreen(destination, logPath) {
  await runCommand("/usr/bin/caffeinate", ["-u", "-t", "1"]);
  try {
    await runCommand("/usr/sbin/screencapture", ["-x", destination]);
  } catch (directError) {
    try {
      await runCommand("/bin/launchctl", [
        "asuser",
        String(process.getuid()),
        "/usr/sbin/screencapture",
        "-x",
        destination,
      ]);
    } catch (launchctlError) {
      try {
        await runInConsoleLaunchAgent("/usr/sbin/screencapture", ["-x", destination]);
      } catch (agentError) {
        await appendFile(
          logPath,
          `Direct capture: ${directError instanceof Error ? directError.message : "unknown failure"}\nGUI bootstrap capture: ${launchctlError instanceof Error ? launchctlError.message : "unknown failure"}\nLaunchAgent capture: ${agentError instanceof Error ? agentError.message : "unknown failure"}\n`,
          "utf8",
        );
        await appendDisplayDiagnostics(logPath);
        throw agentError;
      }
    }
  }
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
    const delivered = await waitForRecord(artifactDirectory, "delivered");
    if (delivered.version !== 1 || delivered.status !== "delivered") {
      throw new Error("Installed application wrote an invalid delivery record");
    }
    await captureScreen(
      path.join(artifactDirectory, "macos-native-notification.png"),
      automationLog,
    );

    const clickResult = await clickSyntheticNotification(automationLog);
    if (clickResult !== "notification-clicked") {
      throw new Error(`Could not activate the synthetic notification: ${clickResult}`);
    }
    const clicked = await waitForRecord(artifactDirectory, "clicked", { timeoutMs: 30_000 });
    if (clicked.version !== 1 || clicked.status !== "clicked") {
      throw new Error("Installed application wrote an invalid click record");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await captureScreen(
      path.join(artifactDirectory, "macos-native-notification-clicked.png"),
      automationLog,
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
