import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addArtifactCacheKeys,
  assertVersionCanPublish,
  cacheKeyPlatformManifest,
  parseManifestVersion,
  runAws,
  runAwsWithRetry,
  selectArtifactNames,
  uploadPlatformManifest,
} from "./desktop-release-helpers.mjs";

const environment = {
  DESKTOP_VERSION: "1.2.3",
  HMM_UPDATE_PUBLIC_ROOT: "https://updates.example/desktop",
  HMM_UPDATE_S3_BUCKET: "updates",
  HMM_UPDATE_S3_ENDPOINT: "https://s3.example",
  RUNNER_TEMP: path.join(os.tmpdir(), "hmm-chat-runner"),
  UPDATE_ARTIFACT_OS: "win",
  UPDATE_MANIFEST: "latest.yml",
};

test("parses quoted and unquoted manifest versions", () => {
  assert.equal(parseManifestVersion("version: 1.2.3\n"), "1.2.3");
  assert.equal(parseManifestVersion('version: "1.2.3"\n'), "1.2.3");
  assert.throws(() => parseManifestVersion("path: app.zip\n"), /no valid version/);
});

test("binds every manifest artifact URL and path to its SHA-512", () => {
  const manifest = [
    "version: 1.2.3",
    "files:",
    "  - url: hmm-chat-1.2.3-mac-arm64.zip",
    "    sha512: arm+/=",
    "    size: 123",
    "  - url: hmm-chat-1.2.3-mac-x64.zip",
    "    sha512: intel+/=",
    "    size: 456",
    "path: hmm-chat-1.2.3-mac-arm64.zip",
    "sha512: arm+/=",
    "",
  ].join("\n");

  const cacheKeyedManifest = addArtifactCacheKeys(manifest);

  assert.match(cacheKeyedManifest, /url: hmm-chat-1\.2\.3-mac-arm64\.zip\?sha512=arm%2B%2F%3D/u);
  assert.match(cacheKeyedManifest, /url: hmm-chat-1\.2\.3-mac-x64\.zip\?sha512=intel%2B%2F%3D/u);
  assert.match(cacheKeyedManifest, /path: hmm-chat-1\.2\.3-mac-arm64\.zip\?sha512=arm%2B%2F%3D/u);
  assert.equal(cacheKeyedManifest.match(/sha512: arm\+\/=/gu)?.length, 2);
  assert.equal(cacheKeyedManifest.match(/sha512: intel\+\/=/gu)?.length, 1);
  assert.throws(() => addArtifactCacheKeys(cacheKeyedManifest), /already has a SHA-512 cache key/);
});

test("rejects a manifest artifact without an adjacent SHA-512", () => {
  assert.throws(
    () =>
      addArtifactCacheKeys(
        ["version: 1.2.3", "files:", "  - url: app.zip", "    size: 123", ""].join("\n"),
      ),
    /only 0 immediately precede a SHA-512 hash/,
  );
});

test("rejects ambiguous artifact URL scalars", () => {
  for (const artifactUrl of [
    "app.zip?channel=latest",
    "app.zip#download",
    "'app.zip'",
    '"app.zip"',
  ]) {
    assert.throws(
      () =>
        addArtifactCacheKeys(
          ["version: 1.2.3", "files:", `  - url: ${artifactUrl}`, "    sha512: hash", ""].join(
            "\n",
          ),
        ),
      /must be an unquoted artifact URL without a query or fragment/,
    );
  }
});

test("rewrites the selected generated platform manifest", async () => {
  const releaseDirectory = await mkdtemp(path.join(os.tmpdir(), "hmm-chat-release-"));
  try {
    const manifestPath = path.join(releaseDirectory, "latest.yml");
    await writeFile(
      manifestPath,
      ["version: 1.2.3", "files:", "  - url: app.exe", "    sha512: hash+/=", ""].join("\n"),
    );
    await cacheKeyPlatformManifest({ environment, releaseDirectory });
    assert.match(await readFile(manifestPath, "utf8"), /url: app\.exe\?sha512=hash%2B%2F%3D/u);
  } finally {
    await rm(releaseDirectory, { force: true, recursive: true });
  }
});

test("selects only exact version and platform artifacts", () => {
  const file = (name) => ({ isFile: () => true, name });
  const directory = (name) => ({ isFile: () => false, name });
  assert.deepEqual(
    selectArtifactNames(
      [
        file("hmm-chat-1.2.3-win-arm64.exe.blockmap"),
        file("hmm-chat-1.2.3-linux-x64.AppImage"),
        directory("hmm-chat-1.2.3-win-unpacked"),
        file("hmm-chat-1.2.3-win-arm64.exe"),
      ],
      "1.2.3",
      "win",
    ),
    ["hmm-chat-1.2.3-win-arm64.exe", "hmm-chat-1.2.3-win-arm64.exe.blockmap"],
  );
});

test("allows a missing or older feed and rejects replacement or rollback", async () => {
  await assertVersionCanPublish({
    environment,
    fetchImplementation: async () => new Response("", { status: 404 }),
  });
  await assertVersionCanPublish({
    environment,
    fetchImplementation: async () => new Response("version: 1.2.2\n"),
  });
  await assert.rejects(
    assertVersionCanPublish({
      environment,
      fetchImplementation: async () => new Response("version: 1.2.3\n"),
    }),
    /already publishes version 1\.2\.3/,
  );
  await assert.rejects(
    assertVersionCanPublish({
      environment,
      fetchImplementation: async () => new Response("version: 2.0.0\n"),
    }),
    /Refusing to move latest\.yml backward/,
  );
});

test("runs AWS without a shell and pins its config to runner temp", () => {
  let invocation;
  runAws(["configure", "set", "default.s3.addressing_style", "path"], {
    environment,
    spawn(command, arguments_, options) {
      invocation = { arguments_, command, options };
      return { status: 0 };
    },
  });

  assert.equal(invocation.command, "aws");
  assert.deepEqual(invocation.arguments_, [
    "configure",
    "set",
    "default.s3.addressing_style",
    "path",
  ]);
  assert.equal(invocation.options.shell, false);
  assert.equal(
    invocation.options.env.AWS_CONFIG_FILE,
    path.join(environment.RUNNER_TEMP, "hmm-chat-aws-config"),
  );
});

test("retries transient AWS command failures with bounded backoff", async () => {
  const delays = [];
  let attempts = 0;
  await runAwsWithRetry(["s3", "cp", "source", "destination"], {
    environment,
    sleep(milliseconds) {
      delays.push(milliseconds);
    },
    spawn() {
      attempts += 1;
      return { status: attempts < 3 ? 1 : 0 };
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2_000, 4_000]);
});

test("validates the generated manifest before uploading it last", async () => {
  const releaseDirectory = await mkdtemp(path.join(os.tmpdir(), "hmm-chat-release-"));
  const calls = [];
  try {
    await writeFile(path.join(releaseDirectory, "latest.yml"), "version: 1.2.3\n");
    await uploadPlatformManifest({
      environment,
      releaseDirectory,
      spawn(command, arguments_, options) {
        calls.push({ arguments_, command, options });
        return { status: 0 };
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments_.slice(-5), [
      "--cache-control",
      "no-cache",
      "--content-type",
      "application/yaml",
      "--no-progress",
    ]);

    await writeFile(path.join(releaseDirectory, "latest.yml"), "version: 1.2.4\n");
    await assert.rejects(
      uploadPlatformManifest({ environment, releaseDirectory }),
      /contains 1\.2\.4, expected 1\.2\.3/,
    );
  } finally {
    await rm(releaseDirectory, { force: true, recursive: true });
  }
});
