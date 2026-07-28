import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";

export const EXPECTED_VITE_VERSION = "8.1.5";

const vitePackagePathPattern = /(?:^|\/)node_modules\/vite$/u;

function packageNameFromPath(packagePath) {
  const nodeModulesMarker = "node_modules/";
  return packagePath.slice(packagePath.lastIndexOf(nodeModulesMarker) + nodeModulesMarker.length);
}

export function validateViteStackLockfile(lockfile, expectedViteVersion = EXPECTED_VITE_VERSION) {
  if (
    lockfile === null ||
    typeof lockfile !== "object" ||
    lockfile.packages === null ||
    typeof lockfile.packages !== "object"
  ) {
    throw new Error("package-lock.json must contain a packages object");
  }

  const packageEntries = Object.entries(lockfile.packages);
  const vitePackages = packageEntries
    .filter(([packagePath]) => vitePackagePathPattern.test(packagePath))
    .map(([packagePath, packageMetadata]) => ({
      packagePath,
      version: packageMetadata?.version,
    }));

  if (vitePackages.length !== 1 || vitePackages[0].version !== expectedViteVersion) {
    const found =
      vitePackages.length === 0
        ? "none"
        : vitePackages
            .map(({ packagePath, version }) => `${String(version)} at ${packagePath}`)
            .join(", ");
    throw new Error(
      `Expected one Vite ${expectedViteVersion} installation in package-lock.json; found ${found}`,
    );
  }

  const incompatiblePeers = [];
  let checkedPeerRanges = 0;
  for (const [packagePath, packageMetadata] of packageEntries) {
    const vitePeerRange = packageMetadata?.peerDependencies?.vite;
    if (typeof vitePeerRange !== "string") {
      continue;
    }

    checkedPeerRanges += 1;
    if (
      semver.validRange(vitePeerRange) === null ||
      !semver.satisfies(expectedViteVersion, vitePeerRange)
    ) {
      incompatiblePeers.push(`${packageNameFromPath(packagePath)} declares vite ${vitePeerRange}`);
    }
  }

  if (incompatiblePeers.length > 0) {
    throw new Error(
      `Vite ${expectedViteVersion} is incompatible with lockfile peer ranges: ${incompatiblePeers.join(
        "; ",
      )}`,
    );
  }

  return {
    checkedPeerRanges,
    vitePath: vitePackages[0].packagePath,
    viteVersion: expectedViteVersion,
  };
}

async function main() {
  const lockfilePath = path.resolve("package-lock.json");
  const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
  const result = validateViteStackLockfile(lockfile);
  console.log(
    `Verified one Vite ${result.viteVersion} installation and ${result.checkedPeerRanges} compatible peer range(s).`,
  );
}

const isMainModule =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
