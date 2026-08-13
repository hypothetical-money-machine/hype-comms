#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, appendFile, chmod, mkdtemp } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const GITHUB_CLI_VERSION = "2.96.0";

const githubCliAssets = new Map([
  [
    "linux-arm64",
    {
      archiveName: `gh_${GITHUB_CLI_VERSION}_linux_arm64.tar.gz`,
      binDirectory: `gh_${GITHUB_CLI_VERSION}_linux_arm64/bin`,
      sha256: "06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909",
    },
  ],
  [
    "linux-x64",
    {
      archiveName: `gh_${GITHUB_CLI_VERSION}_linux_amd64.tar.gz`,
      binDirectory: `gh_${GITHUB_CLI_VERSION}_linux_amd64/bin`,
      sha256: "83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60",
    },
  ],
  [
    "darwin-arm64",
    {
      archiveName: `gh_${GITHUB_CLI_VERSION}_macOS_arm64.zip`,
      binDirectory: `gh_${GITHUB_CLI_VERSION}_macOS_arm64/bin`,
      sha256: "f23a0c37d963aacc3bed703ccbd59b41c5ca22101fab7f00eb2b7cad23aba463",
    },
  ],
  [
    "darwin-x64",
    {
      archiveName: `gh_${GITHUB_CLI_VERSION}_macOS_amd64.zip`,
      binDirectory: `gh_${GITHUB_CLI_VERSION}_macOS_amd64/bin`,
      sha256: "4bd449df9ad639391bc62b8032546f0fe9edcd8526e06682a4f88abd8c5d163c",
    },
  ],
  [
    "win32-arm64",
    {
      archiveName: `gh_${GITHUB_CLI_VERSION}_windows_arm64.zip`,
      binDirectory: "bin",
      sha256: "c517e0b32c98a4ba90ac95af8d12cc3ac55781ab4ab72f9a91ce3de0541d2b09",
    },
  ],
  [
    "win32-x64",
    {
      archiveName: `gh_${GITHUB_CLI_VERSION}_windows_amd64.zip`,
      binDirectory: "bin",
      sha256: "c2d6acc935cd2f00e2144d7e036d5cd82e6b6bd5594e8c75aa75ef2a4ed6aac3",
    },
  ],
]);

export function githubCliAsset(platform, architecture) {
  const asset = githubCliAssets.get(`${platform}-${architecture}`);
  if (asset === undefined) {
    throw new Error(`GitHub CLI is not pinned for ${platform}-${architecture}.`);
  }
  return asset;
}

export function githubCliDownloadUrl(archiveName) {
  return `https://github.com/cli/cli/releases/download/v${GITHUB_CLI_VERSION}/${archiveName}`;
}

export function assertGithubCliChecksum(actual, expected, archiveName) {
  if (actual !== expected) {
    throw new Error(
      `GitHub CLI checksum mismatch for ${archiveName}: expected ${expected}, received ${actual}.`,
    );
  }
}

function runCommand(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with status ${code ?? "unknown"}.`));
      }
    });
  });
}

async function downloadAndVerify(asset, archivePath) {
  const response = await fetch(githubCliDownloadUrl(asset.archiveName), {
    headers: { "user-agent": "hype-comms-desktop-release" },
    redirect: "follow",
  });
  if (!response.ok || response.body === null) {
    throw new Error(
      `GitHub CLI download failed with HTTP ${response.status} ${response.statusText}.`,
    );
  }

  const digest = createHash("sha256");
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    hashingStream,
    createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
  );
  assertGithubCliChecksum(digest.digest("hex"), asset.sha256, asset.archiveName);
}

export async function installGithubCli(environment = process.env) {
  const runnerTemp = environment.RUNNER_TEMP;
  const githubPath = environment.GITHUB_PATH;
  if (runnerTemp === undefined || !path.isAbsolute(runnerTemp)) {
    throw new Error("RUNNER_TEMP must be an absolute path.");
  }
  if (githubPath === undefined || !path.isAbsolute(githubPath)) {
    throw new Error("GITHUB_PATH must be an absolute path.");
  }

  const asset = githubCliAsset(process.platform, process.arch);
  const installDirectory = await mkdtemp(path.join(runnerTemp, "hype-comms-github-cli-"));
  const archivePath = path.join(installDirectory, asset.archiveName);
  await downloadAndVerify(asset, archivePath);
  await runCommand("tar", ["-xf", archivePath, "-C", installDirectory]);

  const binDirectory = path.join(installDirectory, asset.binDirectory);
  const executablePath = path.join(binDirectory, process.platform === "win32" ? "gh.exe" : "gh");
  if (process.platform !== "win32") {
    await chmod(executablePath, 0o755);
  }
  await access(executablePath);
  await appendFile(githubPath, `${binDirectory}${os.EOL}`, "utf8");
  await runCommand(executablePath, ["--version"]);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  installGithubCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
