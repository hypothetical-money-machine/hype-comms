import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

const releaseRoot = path.resolve("apps/desktop/release");
const expectedUpdateProvider = "generic";
const expectedUpdateUrl = "https://updates.hypemm.com/desktop";
const requiredAsarEntries = [
  "/dist/main/index.js",
  "/dist/preload/index.js",
  "/dist/renderer/index.html",
  "/node_modules/electron-updater/package.json",
  "/node_modules/electron-updater/out/main.js",
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
    const executablePath = path.join(macExecutableDirectory, "hype-comms");
    const authorizationAddon = path.join(
      applicationDirectory,
      "Resources",
      "hmm-notification-authorization.node",
    );
    await Promise.all([access(executablePath), access(authorizationAddon)]);
    return executablePath;
  }

  const executableName = process.platform === "win32" ? "hype-comms.exe" : "hype-comms";
  const executablePath = path.join(applicationDirectory, executableName);
  await access(executablePath);
  return executablePath;
}

async function verifyUpdateConfiguration(asarPath) {
  const updateConfigurationPath = path.join(path.dirname(asarPath), "app-update.yml");
  const updateConfiguration = await readFile(updateConfigurationPath, "utf8");

  const valueFor = (key) => {
    const lines = updateConfiguration
      .split(/\r?\n/u)
      .filter((line) => line.trimStart().startsWith(`${key}:`));
    if (lines.length !== 1) {
      throw new Error(`${updateConfigurationPath} must contain exactly one ${key}`);
    }

    const value = lines[0].slice(lines[0].indexOf(":") + 1).trim();
    return (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value;
  };

  const provider = valueFor("provider");
  if (provider !== expectedUpdateProvider) {
    throw new Error(
      `${updateConfigurationPath} provider must be ${expectedUpdateProvider}; found ${provider}`,
    );
  }

  const updateUrl = valueFor("url");
  if (updateUrl !== expectedUpdateUrl) {
    throw new Error(
      `${updateConfigurationPath} update feed must be ${expectedUpdateUrl}; found ${updateUrl}`,
    );
  }
}

const asarPaths = await collectFiles(releaseRoot, "app.asar");
if (asarPaths.length === 0) {
  throw new Error(`No packaged app.asar found under ${releaseRoot}`);
}

for (const asarPath of asarPaths) {
  const entries = new Set(listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/")));
  for (const requiredEntry of requiredAsarEntries) {
    if (!entries.has(requiredEntry)) {
      throw new Error(`${asarPath} is missing ${requiredEntry}`);
    }
  }

  if (![...entries].some((entry) => entry.startsWith("/dist/renderer/assets/"))) {
    throw new Error(`${asarPath} has no bundled renderer assets`);
  }

  await verifyUpdateConfiguration(asarPath);

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
  `Verified updater configuration, ASAR contents, and Electron fuses in ${asarPaths.length} packaged app(s).`,
);
