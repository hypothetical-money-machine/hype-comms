import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";

export function validateZodAlignment(manifests, lockfile) {
  const expected = manifests["packages/contracts"]?.dependencies?.zod;
  if (typeof expected !== "string" || semver.valid(expected) !== expected) {
    throw new Error("Contracts must declare an exact Zod version as a normal dependency");
  }
  const consumers = [];
  for (const [directory, manifest] of Object.entries(manifests)) {
    const declarations = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ].filter((kind) => manifest[kind]?.zod !== undefined);
    if (declarations.length === 0) continue;
    if (
      declarations.length !== 1 ||
      declarations[0] !== "dependencies" ||
      manifest.dependencies.zod !== expected
    ) {
      throw new Error(`${directory} must declare Zod ${expected} as a normal dependency`);
    }
    if (lockfile.packages?.[directory]?.dependencies?.zod !== expected) {
      throw new Error(`${directory} has a stale Zod declaration in package-lock.json`);
    }
    let candidate = directory;
    let resolved;
    while (true) {
      resolved = lockfile.packages?.[path.posix.join(candidate, "node_modules/zod")];
      if (resolved !== undefined || candidate === ".") break;
      candidate = path.posix.dirname(candidate);
    }
    if (resolved?.version !== expected) {
      throw new Error(
        `${directory} resolves Zod ${String(resolved?.version)}; expected ${expected}`,
      );
    }
    consumers.push(directory);
  }
  return { version: expected, consumers };
}

async function main() {
  const root = new URL("../", import.meta.url);
  const manifests = {};
  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(new URL(`${parent}/`, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${parent}/${entry.name}`;
      try {
        manifests[directory] = JSON.parse(
          await readFile(new URL(`${directory}/package.json`, root), "utf8"),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  const lockfile = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  const result = validateZodAlignment(manifests, lockfile);
  console.log(
    `Verified Zod ${result.version} for ${result.consumers.length} first-party consumers.`,
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
