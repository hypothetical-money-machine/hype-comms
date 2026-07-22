import { access, readdir } from "node:fs/promises";
import path from "node:path";

import { listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

const releaseRoot = path.resolve("apps/desktop/release");
const requiredAsarEntries = [
  "/dist/main/index.js",
  "/dist/preload/index.js",
  "/dist/renderer/index.html",
];
const expectedFuses = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
]);

async function collectFiles(directory, matchingName) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await collectFiles(entryPath, matchingName)));
    } else if (entry.isFile() && entry.name === matchingName) {
      matches.push(entryPath);
    }
  }
  return matches;
}

async function executableForAsar(asarPath) {
  const resourcesDirectory = path.dirname(asarPath);
  const applicationDirectory = path.dirname(resourcesDirectory);

  if (path.basename(applicationDirectory) === "Contents") {
    const macExecutableDirectory = path.join(applicationDirectory, "MacOS");
    const executables = (await readdir(macExecutableDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(macExecutableDirectory, entry.name));
    if (executables.length !== 1) {
      throw new Error(`Expected one macOS executable beside ${asarPath}`);
    }
    return executables[0];
  }

  const executableName = process.platform === "win32" ? "hmm-chat.exe" : "hmm-chat";
  const executablePath = path.join(applicationDirectory, executableName);
  await access(executablePath);
  return executablePath;
}

const asarPaths = await collectFiles(releaseRoot, "app.asar");
if (asarPaths.length === 0) {
  throw new Error(`No packaged app.asar found under ${releaseRoot}`);
}

for (const asarPath of asarPaths) {
  const entries = new Set(listPackage(asarPath));
  for (const requiredEntry of requiredAsarEntries) {
    if (!entries.has(requiredEntry)) {
      throw new Error(`${asarPath} is missing ${requiredEntry}`);
    }
  }

  if (![...entries].some((entry) => entry.startsWith("/dist/renderer/assets/"))) {
    throw new Error(`${asarPath} has no bundled renderer assets`);
  }

  const executablePath = await executableForAsar(asarPath);
  const fuseWire = await getCurrentFuseWire(executablePath);
  for (const [fuse, expectedState] of expectedFuses) {
    if (fuseWire[fuse] !== expectedState) {
      throw new Error(
        `${executablePath} has ${FuseV1Options[fuse]}=${String(fuseWire[fuse])}; expected ${String(expectedState)}`,
      );
    }
  }
}

console.log(
  `Verified renderer contents and Electron fuses in ${asarPaths.length} packaged app(s).`,
);
