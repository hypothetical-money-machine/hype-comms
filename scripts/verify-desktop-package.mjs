import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractFile, listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

import { isReservedInvalidHostname } from "../apps/desktop/api-origin-policy.mjs";
import {
  resolveAgentWakePackageEvidence as resolveExpectedAgentWakePackageEvidence,
  resolveAgentWakeRollout as resolveExpectedAgentWakeBuild,
} from "../apps/desktop/agent-wake-rollout.mjs";
import { resolveDesktopBuildFlavor } from "../apps/desktop/build-flavor.mjs";

const expectedUpdateProvider = "generic";
const agentWakeConfigurationCall =
  /resolveAgentWakeConfigurationPath\(\{\s*compiledIn:\s*(true|false),/gu;
const agentWakeOperatorCall =
  /resolveAgentWakeOperatorRequestPath\(\{\s*compiledIn:\s*(true|false),/gu;
// Vite substitutes a dedicated updates-allowed define directly. Accept the equivalent boolean
// spellings Rolldown may retain or minify without depending on constant folding.
const agentWakeUpdaterPolicy = /updatesAllowed:\s*(!?)(true|false|[01]),/gu;
const requiredAsarEntries = [
  "/dist/main/build-metadata.json",
  "/dist/main/index.js",
  "/dist/main/claude-acp-worker.js",
  "/dist/main/codex-app-server-worker.js",
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

  const expectedPublisherName = process.env.HYPE_COMMS_WINDOWS_PUBLISHER_NAME?.trim();
  if (expectedPublisherName) {
    const publisherName = valueFor("publisherName");
    if (publisherName !== expectedPublisherName) {
      throw new Error(
        `${updateConfigurationPath} publisherName must be ${expectedPublisherName}; found ${publisherName}`,
      );
    }
  }
}

export function verifyPackageEntries(asarPath, entries) {
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

  const packagedCodexPackages = [...entries].filter((entry) =>
    entry.startsWith("/node_modules/@openai/codex"),
  );
  if (packagedCodexPackages.length > 0) {
    throw new Error(
      `${asarPath} contains bundled official Codex packages; AI Channel must use the user-installed Codex CLI`,
    );
  }

  const packagedCodexExecutables = [...entries].filter((entry) =>
    /\/codex(?:\.exe)?$/iu.test(entry),
  );
  if (packagedCodexExecutables.length > 0) {
    throw new Error(
      `${asarPath} contains a bundled Codex executable; AI Channel must use the user-installed Codex CLI`,
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

export function resolveExpectedProductionApiOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      "HYPE_COMMS_API_ORIGIN must name the deployed HTTPS API when verifying a production package",
    );
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("HYPE_COMMS_API_ORIGIN must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    isReservedInvalidHostname(url.hostname)
  ) {
    throw new Error(
      "HYPE_COMMS_API_ORIGIN must be a deployed HTTPS origin without credentials, a path, or a .invalid hostname",
    );
  }
  return url.origin;
}

export function verifyPackagedApiOrigin(
  asarPath,
  expectedApiOrigin,
  extractFileImplementation = extractFile,
) {
  const metadataPath = path.join("dist", "main", "build-metadata.json");
  let metadataSource;
  try {
    metadataSource = extractFileImplementation(asarPath, metadataPath).toString("utf8");
  } catch (error) {
    throw new Error(`${asarPath} contains unreadable desktop build metadata`, { cause: error });
  }

  let metadata;
  try {
    metadata = JSON.parse(metadataSource);
  } catch (error) {
    throw new Error(`${asarPath} has invalid desktop build metadata`, { cause: error });
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).length !== 1 ||
    typeof metadata.apiOrigin !== "string"
  ) {
    throw new Error(`${asarPath} has invalid desktop build metadata`);
  }
  if (metadata.apiOrigin !== expectedApiOrigin) {
    throw new Error(
      `${asarPath} API origin must be ${expectedApiOrigin}; found ${metadata.apiOrigin}`,
    );
  }
}

export { resolveExpectedAgentWakeBuild, resolveExpectedAgentWakePackageEvidence };

export function verifyAgentWakeBuild(
  asarPath,
  expectedEnabled,
  extractFileImplementation = extractFile,
) {
  const mainPath = path.join("dist", "main", "index.js");
  let source;
  try {
    source = extractFileImplementation(asarPath, mainPath).toString("utf8");
  } catch (error) {
    throw new Error(`${asarPath} contains an unreadable ${mainPath}`, { cause: error });
  }

  const configurationMatches = [...source.matchAll(agentWakeConfigurationCall)];
  const operatorMatches = [...source.matchAll(agentWakeOperatorCall)];
  if (configurationMatches.length !== 1 || operatorMatches.length !== 1) {
    throw new Error(`${asarPath} has an ambiguous or missing Agent Wake build marker`);
  }

  const expected = String(expectedEnabled);
  if (configurationMatches[0][1] !== expected || operatorMatches[0][1] !== expected) {
    throw new Error(
      `${asarPath} Agent Wake build state does not match HYPE_COMMS_AGENT_WAKE_ENABLED=${expectedEnabled ? "1" : "0"}`,
    );
  }
}

export function verifyAgentWakeUpdateIsolation(
  asarPath,
  expectedEvidenceBuild,
  extractFileImplementation = extractFile,
) {
  const mainPath = path.join("dist", "main", "index.js");
  let source;
  try {
    source = extractFileImplementation(asarPath, mainPath).toString("utf8");
  } catch (error) {
    throw new Error(`${asarPath} contains an unreadable ${mainPath}`, { cause: error });
  }

  const matches = [...source.matchAll(agentWakeUpdaterPolicy)];
  if (matches.length !== 1) {
    throw new Error(`${asarPath} has an ambiguous or missing Agent Wake updater-isolation marker`);
  }
  const negated = matches[0][1] === "!";
  const literal = matches[0][2] === "true" || matches[0][2] === "1";
  const updatesAllowed = negated ? !literal : literal;
  if (updatesAllowed === expectedEvidenceBuild) {
    throw new Error(
      `${asarPath} Agent Wake updater isolation does not match HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED=${expectedEvidenceBuild ? "1" : "0"}`,
    );
  }
}

export async function verifyDesktopPackages(
  flavor = resolveDesktopBuildFlavor(),
  releaseRoot = path.resolve("apps/desktop", flavor.releaseDirectory),
) {
  const expectedApiOrigin = flavor.isProduction
    ? resolveExpectedProductionApiOrigin(process.env.HYPE_COMMS_API_ORIGIN)
    : null;
  const expectedAgentWakeBuild = resolveExpectedAgentWakeBuild(
    process.env.HYPE_COMMS_AGENT_WAKE_ENABLED,
  );
  const expectedAgentWakePackageEvidence = resolveExpectedAgentWakePackageEvidence(
    process.env.HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED,
    expectedAgentWakeBuild,
  );
  const excludedDirectories = excludedPackageDirectories(flavor, releaseRoot);
  const asarPaths = await collectPackageFiles(releaseRoot, "app.asar", excludedDirectories);
  if (asarPaths.length === 0) {
    throw new Error(`No packaged app.asar found under ${releaseRoot}`);
  }

  for (const asarPath of asarPaths) {
    const entries = new Set(listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/")));
    verifyPackageEntries(asarPath, entries);
    verifyPackageMetadata(asarPath, flavor);
    if (expectedApiOrigin !== null) {
      verifyPackagedApiOrigin(asarPath, expectedApiOrigin);
    }
    verifyAgentWakeBuild(asarPath, expectedAgentWakeBuild);
    verifyAgentWakeUpdateIsolation(asarPath, expectedAgentWakePackageEvidence);
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

  const apiOriginCheck = expectedApiOrigin === null ? "" : "the API origin, ";
  console.log(
    `Verified ${apiOriginCheck}Agent Wake build state, updater isolation, AI Channel worker contents, and Electron fuses in ${asarPaths.length} ${flavor.name} packaged app(s).`,
  );
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) await verifyDesktopPackages();
