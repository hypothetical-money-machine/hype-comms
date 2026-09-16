// Guards the root lockfile against dependency-resolution drift for packages where multiple
// concurrent versions would be unsafe. Originally scoped to Vite (mixed Vite majors across
// apps/desktop and its plugins can break the dev/build pipeline); also covers zod, since
// packages/contracts and its consumers must resolve to a single zod instance for schema
// identity checks (`instanceof`, branded types) to hold across package boundaries.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";

export const EXPECTED_VITE_VERSION = "8.2.1";
export const EXPECTED_ZOD_VERSION = "4.4.3";

const vitePackagePathPattern = /(?:^|\/)node_modules\/vite$/u;
const zodPackagePathPattern = /(?:^|\/)node_modules\/zod$/u;

function packageNameFromPath(packagePath) {
  const nodeModulesMarker = "node_modules/";
  return packagePath.slice(packagePath.lastIndexOf(nodeModulesMarker) + nodeModulesMarker.length);
}

function findPackageInstalls(packageEntries, packagePathPattern) {
  return packageEntries
    .filter(([packagePath]) => packagePathPattern.test(packagePath))
    .map(([packagePath, packageMetadata]) => ({
      packagePath,
      version: packageMetadata?.version,
    }));
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
  const vitePackages = findPackageInstalls(packageEntries, vitePackagePathPattern);

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

export function validateZodStackLockfile(lockfile, expectedZodVersion = EXPECTED_ZOD_VERSION) {
  if (
    lockfile === null ||
    typeof lockfile !== "object" ||
    lockfile.packages === null ||
    typeof lockfile.packages !== "object"
  ) {
    throw new Error("package-lock.json must contain a packages object");
  }

  const packageEntries = Object.entries(lockfile.packages);
  const zodPackages = findPackageInstalls(packageEntries, zodPackagePathPattern);

  if (zodPackages.length !== 1 || zodPackages[0].version !== expectedZodVersion) {
    const found =
      zodPackages.length === 0
        ? "none"
        : zodPackages
            .map(({ packagePath, version }) => `${String(version)} at ${packagePath}`)
            .join(", ");
    throw new Error(
      `Expected one zod ${expectedZodVersion} installation in package-lock.json; found ${found}`,
    );
  }

  return {
    zodPath: zodPackages[0].packagePath,
    zodVersion: expectedZodVersion,
  };
}

async function main() {
  const lockfilePath = path.resolve("package-lock.json");
  const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
  const viteResult = validateViteStackLockfile(lockfile);
  console.log(
    `Verified one Vite ${viteResult.viteVersion} installation and ${viteResult.checkedPeerRanges} compatible peer range(s).`,
  );
  const zodResult = validateZodStackLockfile(lockfile);
  console.log(`Verified one zod ${zodResult.zodVersion} installation at ${zodResult.zodPath}.`);
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
