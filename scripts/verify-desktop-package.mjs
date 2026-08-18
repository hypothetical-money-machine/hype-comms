import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractFile, listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

import { resolveDesktopBuildFlavor } from "../apps/desktop/build-flavor.mjs";

const expectedUpdateProvider = "generic";
const requiredAsarEntries = [
  "/dist/main/index.js",
  "/dist/main/claude-acp-worker.js",
  "/dist/preload/index.js",
  "/dist/renderer/index.html",
  "/node_modules/@agentclientprotocol/claude-agent-acp/package.json",
  "/node_modules/@agentclientprotocol/sdk/package.json",
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

export async function collectPackageFiles(directory, matchingName, excludedDirectories = []) {
  const excludedPaths = new Set(excludedDirectories.map((entry) => path.resolve(entry)));

  const collect = async (currentDirectory) => {
    const matches = [];
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedPaths.has(path.resolve(entryPath))) {
          matches.push(...(await collect(entryPath)));
        }
      } else if (entry.isFile() && entry.name === matchingName) {
        matches.push(entryPath);
      }
    }
    return matches;
  };

  return collect(directory);
}

export function excludedPackageDirectories(flavor, releaseRoot) {
  return flavor.isProduction ? [path.join(releaseRoot, "dev")] : [];
}

async function executableForAsar(asarPath, flavor) {
  const resourcesDirectory = path.dirname(asarPath);
  const applicationDirectory = path.dirname(resourcesDirectory);

  if (path.basename(applicationDirectory) === "Contents") {
    const macExecutableDirectory = path.join(applicationDirectory, "MacOS");
    const executablePath = path.join(macExecutableDirectory, flavor.executableName);
    const authorizationAddon = path.join(
      applicationDirectory,
      "Resources",
      "hmm-notification-authorization.node",
    );
    await Promise.all([access(executablePath), access(authorizationAddon)]);
    return executablePath;
  }

  const executableName =
    process.platform === "win32" ? `${flavor.executableName}.exe` : flavor.executableName;
  const executablePath = path.join(applicationDirectory, executableName);
  await access(executablePath);
  return executablePath;
}

const isMissingFileError = (error) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export async function verifyUpdateConfiguration(
  asarPath,
  flavor,
  readFileImplementation = readFile,
) {
  const updateConfigurationPath = path.join(path.dirname(asarPath), "app-update.yml");
  let updateConfiguration;
  try {
    updateConfiguration = await readFileImplementation(updateConfigurationPath, "utf8");
  } catch (error) {
    if (flavor.updateUrl === null && isMissingFileError(error)) return;
    throw error;
  }

  if (flavor.updateUrl === null) {
    throw new Error(
      `${updateConfigurationPath} must not exist in a ${flavor.name} package; development builds cannot contain a publish feed`,
    );
  }

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
  if (updateUrl !== flavor.updateUrl) {
    throw new Error(
      `${updateConfigurationPath} update feed must be ${flavor.updateUrl}; found ${updateUrl}`,
    );
  }
}

export function verifyPackageMetadata(asarPath, flavor, extractFileImplementation = extractFile) {
  const packageJsonPath = "package.json";
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(
      extractFileImplementation(asarPath, packageJsonPath).toString("utf8"),
    );
  } catch (error) {
    throw new Error(`${asarPath} contains invalid ${packageJsonPath}`, { cause: error });
  }

  const expectedMetadata = {
    name: flavor.packageName,
    desktopName: flavor.desktopName,
    ...(flavor.isProduction ? {} : { productName: flavor.productName }),
  };
  for (const [key, expectedValue] of Object.entries(expectedMetadata)) {
    if (packageMetadata[key] !== expectedValue) {
      throw new Error(
        `${asarPath} package metadata ${key} must be ${expectedValue}; found ${String(packageMetadata[key])}`,
      );
    }
  }

  if (flavor.isProduction && Object.hasOwn(packageMetadata, "productName")) {
    throw new Error(
      `${asarPath} production package metadata must not override productName; the released package name determines the stable profile path`,
    );
  }
}

export async function verifyDesktopPackages(
  flavor = resolveDesktopBuildFlavor(),
  releaseRoot = path.resolve("apps/desktop", flavor.releaseDirectory),
) {
  const excludedDirectories = excludedPackageDirectories(flavor, releaseRoot);
  const asarPaths = await collectPackageFiles(releaseRoot, "app.asar", excludedDirectories);
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

    const packagedClaudeExecutables = [...entries].filter((entry) =>
      entry.startsWith("/node_modules/@anthropic-ai/claude-agent-sdk-"),
    );
    if (packagedClaudeExecutables.length > 0) {
      throw new Error(
        `${asarPath} contains host-specific Claude executables; AI Channel must use the user-installed Claude Code binary`,
      );
    }

    verifyPackageMetadata(asarPath, flavor);
    await verifyUpdateConfiguration(asarPath, flavor);

    const executablePath = await executableForAsar(asarPath, flavor);
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
    `Verified updater isolation, AI Channel worker contents, and Electron fuses in ${asarPaths.length} ${flavor.name} packaged app(s).`,
  );
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) await verifyDesktopPackages();
