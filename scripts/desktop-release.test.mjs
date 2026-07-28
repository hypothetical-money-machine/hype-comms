import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertVersionCanPublish,
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
