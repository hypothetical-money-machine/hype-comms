import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const releaseRoot = path.resolve("apps/desktop/release");
const expectedTeamIdentifier = "5LTMYWRTYR";

async function collectAppBundles(directory) {
  const appBundles = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (path.extname(entry.name) === ".app") {
      appBundles.push(entryPath);
    } else {
      appBundles.push(...(await collectAppBundles(entryPath)));
    }
  }
  return appBundles;
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

if (process.platform !== "darwin") {
  throw new Error("macOS release verification must run on macOS");
}

const appBundles = (await collectAppBundles(releaseRoot)).sort();
if (appBundles.length === 0) {
  throw new Error(`No packaged macOS application found under ${releaseRoot}`);
}

for (const appBundle of appBundles) {
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
    "/usr/bin/xcrun",
    ["stapler", "validate", appBundle],
    `Stapled notarization ticket validation for ${appBundle}`,
  );
}

console.log(
  `Verified ${expectedTeamIdentifier} Developer ID signatures and stapled notarization tickets in ${appBundles.length} packaged macOS app(s).`,
);
