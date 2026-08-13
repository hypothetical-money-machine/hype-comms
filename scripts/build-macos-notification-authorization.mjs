import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(
  repositoryRoot,
  "apps/desktop/native/macos-notification-authorization.swift",
);
const outputDirectory = path.join(repositoryRoot, "apps/desktop/native-build/macos");
const output = path.join(outputDirectory, "hmm-notification-authorization");

async function run(command, arguments_) {
  const child = spawn(command, arguments_, { stdio: "inherit" });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (status.code !== 0) {
    throw new Error(`${command} failed with ${status.signal ?? `code ${String(status.code)}`}`);
  }
}

if (process.platform !== "darwin") {
  throw new Error("The macOS notification authorization helper must be built on macOS");
}

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const architectures = ["arm64", "x86_64"];
const architectureOutputs = architectures.map((architecture) => `${output}.${architecture}`);
for (const [index, architecture] of architectures.entries()) {
  await run("/usr/bin/xcrun", [
    "swiftc",
    "-parse-as-library",
    "-O",
    "-target",
    `${architecture}-apple-macos11`,
    "-framework",
    "AppKit",
    "-framework",
    "Foundation",
    "-framework",
    "UserNotifications",
    source,
    "-o",
    architectureOutputs[index],
  ]);
}
await run("/usr/bin/lipo", ["-create", ...architectureOutputs, "-output", output]);
await run("/usr/bin/lipo", [output, "-verify_arch", ...architectures]);
