import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  GITHUB_CLI_VERSION,
  assertGithubCliChecksum,
  githubCliAsset,
  githubCliDownloadUrl,
  installGithubCli,
} from "./install-github-cli.mjs";

test("pins verified GitHub CLI archives for every native runner", () => {
  const expectedAssets = new Map([
    [
      "linux-arm64",
      [
        "gh_2.96.0_linux_arm64.tar.gz",
        "06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909",
      ],
    ],
    [
      "linux-x64",
      [
        "gh_2.96.0_linux_amd64.tar.gz",
        "83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60",
      ],
    ],
    [
      "darwin-arm64",
      [
        "gh_2.96.0_macOS_arm64.zip",
        "f23a0c37d963aacc3bed703ccbd59b41c5ca22101fab7f00eb2b7cad23aba463",
      ],
    ],
    [
      "darwin-x64",
      [
        "gh_2.96.0_macOS_amd64.zip",
        "4bd449df9ad639391bc62b8032546f0fe9edcd8526e06682a4f88abd8c5d163c",
      ],
    ],
    [
      "win32-arm64",
      [
        "gh_2.96.0_windows_arm64.zip",
        "c517e0b32c98a4ba90ac95af8d12cc3ac55781ab4ab72f9a91ce3de0541d2b09",
      ],
    ],
    [
      "win32-x64",
      [
        "gh_2.96.0_windows_amd64.zip",
        "c2d6acc935cd2f00e2144d7e036d5cd82e6b6bd5594e8c75aa75ef2a4ed6aac3",
      ],
    ],
  ]);

  for (const [target, [archiveName, sha256]] of expectedAssets) {
    const separator = target.lastIndexOf("-");
    const asset = githubCliAsset(target.slice(0, separator), target.slice(separator + 1));
    assert.equal(asset.archiveName, archiveName);
    assert.equal(asset.sha256, sha256);
    assert.equal(
      githubCliDownloadUrl(asset.archiveName),
      `https://github.com/cli/cli/releases/download/v${GITHUB_CLI_VERSION}/${archiveName}`,
    );
  }
});

test("rejects unsupported GitHub CLI targets", () => {
  assert.throws(() => githubCliAsset("freebsd", "arm64"), /not pinned for freebsd-arm64/u);
  assert.throws(() => githubCliAsset("linux", "riscv64"), /not pinned for linux-riscv64/u);
});

test("fails closed when a GitHub CLI checksum differs", () => {
  assert.doesNotThrow(() => assertGithubCliChecksum("a".repeat(64), "a".repeat(64), "gh.zip"));
  assert.throws(
    () => assertGithubCliChecksum("b".repeat(64), "a".repeat(64), "gh.zip"),
    /checksum mismatch for gh\.zip/u,
  );
});

test("rejects unsafe runner paths before downloading", async () => {
  await assert.rejects(installGithubCli({}), /RUNNER_TEMP must be an absolute path/u);
  await assert.rejects(
    installGithubCli({ GITHUB_PATH: path.resolve("github-path"), RUNNER_TEMP: "relative" }),
    /RUNNER_TEMP must be an absolute path/u,
  );
  await assert.rejects(
    installGithubCli({ RUNNER_TEMP: path.resolve("runner") }),
    /GITHUB_PATH must be an absolute path/u,
  );
});
