import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function security(args) {
  const result = spawnSync("/usr/bin/security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  // Do not expose arguments or native stderr: import and unlock arguments contain credentials.
  if (result.error !== undefined || result.status !== 0)
    throw new Error(`macOS security ${args[0]} failed`);
  return result.stdout;
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/u.test(value))
    throw new Error(`${name} is required and must be a single line`);
  return value;
}

function signingPaths(environment) {
  const directory = required(environment, "RUNNER_TEMP");
  return {
    certificate: path.join(directory, "hype-comms-signing-certificate.p12"),
    keychain: path.join(directory, "hype-comms-signing.keychain-db"),
    original: path.join(directory, "hype-comms-original-keychains.txt"),
    pending: path.join(directory, "hype-comms-original-keychains.txt.pending"),
    apiKey: path.join(directory, "hype-comms-notary-api-key.p8"),
  };
}

export function parseKeychainList(source) {
  return source
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      let value;
      try {
        value = JSON.parse(line.trim());
      } catch {
        throw new Error("Could not parse the original macOS keychain search list");
      }
      if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0]/u.test(value))
        throw new Error("Could not parse the original macOS keychain search list");
      return value;
    });
}

function decodeSecret(value, name) {
  const encoded = value.replace(/^base64:/u, "");
  if (encoded.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
    throw new Error(`${name} must contain base64 data`);
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length === 0 ||
    bytes.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")
  )
    throw new Error(`${name} must contain base64 data`);
  return bytes;
}

export function selectSigningIdentity(source, teamId) {
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) throw new Error("Expected macOS team ID is invalid");
  const pattern = new RegExp(
    `^\\s*\\d+\\)\\s+([a-fA-F0-9]{40})\\s+"Developer ID Application: .+ \\(${teamId}\\)"$`,
    "u",
  );
  const matches = source.split(/\r?\n/u).flatMap((line) => {
    const match = pattern.exec(line);
    return match === null ? [] : [match[1]];
  });
  if (matches.length !== 1)
    throw new Error(
      `The signing keychain must contain exactly one ${teamId} Developer ID Application identity`,
    );
  return matches[0];
}

export async function configureMacosSigning({
  environment = process.env,
  execute = security,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") throw new Error("macOS signing requires a macOS runner");
  const files = signingPaths(environment);
  const certificate = decodeSecret(
    required(environment, "HYPE_COMMS_MACOS_CSC_LINK"),
    "Signing certificate",
  );
  const certificatePassword = required(environment, "HYPE_COMMS_MACOS_CSC_KEY_PASSWORD");
  const apiKey = decodeSecret(
    required(environment, "HYPE_COMMS_MACOS_APPLE_API_KEY_BASE64"),
    "Notarization API key",
  );
  const apiKeyId = required(environment, "HYPE_COMMS_MACOS_APPLE_API_KEY_ID");
  const apiIssuer = required(environment, "HYPE_COMMS_MACOS_APPLE_API_ISSUER");
  const teamId = required(environment, "EXPECTED_MACOS_TEAM_ID");
  const githubEnv = required(environment, "GITHUB_ENV");
  const rootCertificates = path.join(
    required(environment, "GITHUB_WORKSPACE"),
    "node_modules/app-builder-lib/certs/root_certs.keychain",
  );
  try {
    await lstat(files.original);
    throw new Error("Restore the previous macOS keychain list before configuring signing again");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const original = await execute(["list-keychains", "-d", "user"]);
  const keychains = parseKeychainList(original);
  await writeFile(files.pending, original, { mode: 0o600, flag: "wx" });
  await rename(files.pending, files.original);
  await writeFile(files.certificate, certificate, { mode: 0o600, flag: "wx" });
  await writeFile(files.apiKey, apiKey, { mode: 0o600, flag: "wx" });
  const password = randomBytes(32).toString("hex");
  // This keychain belongs to this job. Always keep the original search list for recovery first.
  try {
    await execute(["delete-keychain", files.keychain]);
  } catch {
    /* May not exist yet. */
  }
  await execute(["create-keychain", "-p", password, files.keychain]);
  await execute(["set-keychain-settings", "-lut", "21600", files.keychain]);
  await execute(["unlock-keychain", "-p", password, files.keychain]);
  await execute([
    "import",
    files.certificate,
    "-k",
    files.keychain,
    "-P",
    certificatePassword,
    "-T",
    "/usr/bin/codesign",
    "-T",
    "/usr/bin/productbuild",
  ]);
  await execute([
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:",
    "-s",
    "-k",
    password,
    files.keychain,
  ]);
  await execute([
    "list-keychains",
    "-d",
    "user",
    "-s",
    files.keychain,
    rootCertificates,
    ...keychains.filter((entry) => entry !== files.keychain && entry !== rootCertificates),
  ]);
  const identity = selectSigningIdentity(
    await execute(["find-identity", "-v", "-p", "codesigning", files.keychain]),
    teamId,
  );
  await appendFile(
    githubEnv,
    `CSC_KEYCHAIN=${files.keychain}\nCSC_NAME=${identity}\nAPPLE_API_KEY=${files.apiKey}\nAPPLE_API_KEY_ID=${apiKeyId}\nAPPLE_API_ISSUER=${apiIssuer}\n`,
  );
}

export async function cleanupMacosSigning({
  environment = process.env,
  execute = security,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") throw new Error("macOS signing cleanup requires a macOS runner");
  const files = signingPaths(environment);
  const errors = [];
  let original;
  try {
    original = await readFile(files.original, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") errors.push(error);
  }
  if (original !== undefined) {
    try {
      const keychains = parseKeychainList(original).filter((entry) => entry !== files.keychain);
      await execute(["list-keychains", "-d", "user", "-s", ...keychains]);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await execute(["delete-keychain", files.keychain]);
  } catch {
    /* An interrupted setup may not have created it. */
  }
  for (const file of [files.certificate, files.keychain, files.pending, files.apiKey]) {
    try {
      await rm(file, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0)
    throw new Error(
      `macOS signing cleanup failed; preserving ${files.original} for manual keychain-list recovery`,
    );
  await rm(files.original, { force: true });
}
