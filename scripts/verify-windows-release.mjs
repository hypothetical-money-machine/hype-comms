import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const releaseRoot = path.resolve("apps/desktop/release");
const nsisInstallerPattern = /^hype-comms-\d+\.\d+\.\d+-win-(?:x64|arm64)\.exe$/u;
const unpackedExecutableName = "hype-comms.exe";

export function excludedWindowsReleaseDirectories(directory) {
  return [path.join(directory, "dev")];
}

export async function collectWindowsSignedArtifacts(directory, excludedDirectories = []) {
  const excludedPaths = new Set(excludedDirectories.map((entry) => path.resolve(entry)));

  const collect = async (currentDirectory) => {
    const artifacts = [];
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedPaths.has(path.resolve(entryPath))) {
          artifacts.push(...(await collect(entryPath)));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (nsisInstallerPattern.test(entry.name) || entry.name === unpackedExecutableName) {
        artifacts.push(entryPath);
      }
    }
    return artifacts;
  };

  return collect(directory);
}

export function parseAuthenticodeSignature(output, artifactPath) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Authenticode inspection for ${artifactPath} returned invalid JSON${
        output.trim() === "" ? "" : `:\n${output}`
      }`,
      { cause: error },
    );
  }

  const signature = Array.isArray(parsed) ? parsed[0] : parsed;
  if (signature === undefined || typeof signature !== "object" || signature === null) {
    throw new Error(`Authenticode inspection for ${artifactPath} returned no signature object`);
  }

  return signature;
}

export function assertAuthenticodeSignature(signature, artifactPath, publisherName) {
  const status = signature.Status;
  const valid = status === "Valid" || status === 0;
  if (!valid) {
    const statusMessage =
      typeof signature.StatusMessage === "string" && signature.StatusMessage.trim() !== ""
        ? ` (${signature.StatusMessage})`
        : "";
    throw new Error(
      `${artifactPath} is not Authenticode-valid; Get-AuthenticodeSignature status is ${String(status)}${statusMessage}`,
    );
  }

  const subject =
    signature.SignerCertificate &&
    typeof signature.SignerCertificate === "object" &&
    typeof signature.SignerCertificate.Subject === "string"
      ? signature.SignerCertificate.Subject
      : "";
  if (subject !== publisherName) {
    throw new Error(
      `${artifactPath} is signed by ${subject === "" ? "an unknown publisher" : subject}; expected ${publisherName}`,
    );
  }
}

function escapePowerShellSingleQuotedPath(filePath) {
  return filePath.replaceAll("'", "''");
}

function inspectAuthenticodeSignature(artifactPath, spawnImplementation) {
  const result = spawnImplementation(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Get-AuthenticodeSignature -LiteralPath '${escapePowerShellSingleQuotedPath(artifactPath)}' | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

  if (result.error !== undefined) {
    throw new Error(
      `Authenticode inspection for ${artifactPath} could not run: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Authenticode inspection for ${artifactPath} failed${output === "" ? "" : `:\n${output}`}`,
    );
  }

  return parseAuthenticodeSignature(result.stdout ?? "", artifactPath);
}

export async function verifyWindowsRelease({
  releaseDirectory = releaseRoot,
  publisherName = process.env.HYPE_COMMS_WINDOWS_PUBLISHER_NAME,
  platform = process.platform,
  spawnImplementation = spawnSync,
} = {}) {
  if (platform !== "win32") {
    throw new Error("Windows release verification must run on Windows");
  }
  if (typeof publisherName !== "string" || publisherName.trim() === "") {
    throw new Error(
      "Windows release verification requires HYPE_COMMS_WINDOWS_PUBLISHER_NAME to match the signed publisher subject",
    );
  }

  const expectedPublisher = publisherName.trim();
  const artifacts = (
    await collectWindowsSignedArtifacts(
      releaseDirectory,
      excludedWindowsReleaseDirectories(releaseDirectory),
    )
  ).sort();
  const installers = artifacts.filter((artifactPath) =>
    nsisInstallerPattern.test(path.basename(artifactPath)),
  );
  const executables = artifacts.filter(
    (artifactPath) => path.basename(artifactPath) === unpackedExecutableName,
  );
  if (installers.length === 0 || executables.length === 0) {
    throw new Error(
      `Windows release verification requires at least one NSIS installer and one unpacked ${unpackedExecutableName} under ${releaseDirectory}`,
    );
  }

  for (const artifactPath of artifacts) {
    const signature = inspectAuthenticodeSignature(artifactPath, spawnImplementation);
    assertAuthenticodeSignature(signature, artifactPath, expectedPublisher);
  }

  console.log(
    `Verified Authenticode signatures for publisher ${expectedPublisher} on ${artifacts.length} Windows artifact(s).`,
  );
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) await verifyWindowsRelease();
