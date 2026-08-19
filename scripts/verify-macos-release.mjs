import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const releaseRoot = path.resolve("apps/desktop/release");
const expectedTeamIdentifier = "5LTMYWRTYR";

export async function collectAppBundles(directory, excludedDirectories = []) {
  const excludedPaths = new Set(excludedDirectories.map((entry) => path.resolve(entry)));

  const collect = async (currentDirectory) => {
    const appBundles = [];
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const entryPath = path.join(currentDirectory, entry.name);
      if (excludedPaths.has(path.resolve(entryPath))) continue;

      if (path.extname(entry.name) === ".app") {
        appBundles.push(entryPath);
      } else {
        appBundles.push(...(await collect(entryPath)));
      }
    }
    return appBundles;
  };

  return collect(directory);
}

export function excludedMacosReleaseDirectories(directory) {
  return [path.join(directory, "dev")];
}

function runCommand(command, args, description) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

  if (result.error !== undefined) {
    throw new Error(`${description} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${description} failed${output === "" ? "" : `:\n${output}`}`);
  }

  return output;
}

export async function verifyMacosRelease() {
  if (process.platform !== "darwin") {
    throw new Error("macOS release verification must run on macOS");
  }

  const appBundles = (
    await collectAppBundles(releaseRoot, excludedMacosReleaseDirectories(releaseRoot))
  ).sort();
  if (appBundles.length === 0) {
    throw new Error(`No packaged macOS application found under ${releaseRoot}`);
  }

  for (const appBundle of appBundles) {
    const authorizationAddon = path.join(
      appBundle,
      "Contents",
      "Resources",
      "hmm-notification-authorization.node",
    );
    runCommand(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", appBundle],
      `Code signature verification for ${appBundle}`,
    );

    const signingDetails = runCommand(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", appBundle],
      `Code signature inspection for ${appBundle}`,
    );
    if (!/^Authority=Developer ID Application:/mu.test(signingDetails)) {
      throw new Error(`${appBundle} is not signed by a Developer ID Application authority`);
    }
    if (!signingDetails.split("\n").includes(`TeamIdentifier=${expectedTeamIdentifier}`)) {
      throw new Error(
        `${appBundle} is not signed by the expected ${expectedTeamIdentifier} developer team`,
      );
    }

    runCommand(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--verbose=2", authorizationAddon],
      `Notification authorization addon signature verification for ${appBundle}`,
    );
    const helperSigningDetails = runCommand(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", authorizationAddon],
      `Notification authorization addon signature inspection for ${appBundle}`,
    );
    if (!helperSigningDetails.split("\n").includes(`TeamIdentifier=${expectedTeamIdentifier}`)) {
      throw new Error(
        `${authorizationAddon} is not signed by the expected ${expectedTeamIdentifier} developer team`,
      );
    }
    runCommand(
      "/usr/bin/lipo",
      [authorizationAddon, "-verify_arch", "arm64", "x86_64"],
      `Notification authorization addon architecture verification for ${appBundle}`,
    );

    runCommand(
      "/usr/bin/xcrun",
      ["stapler", "validate", appBundle],
      `Stapled notarization ticket validation for ${appBundle}`,
    );
  }

  console.log(
    `Verified ${expectedTeamIdentifier} Developer ID signatures and stapled notarization tickets in ${appBundles.length} packaged macOS app(s).`,
  );
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) await verifyMacosRelease();
