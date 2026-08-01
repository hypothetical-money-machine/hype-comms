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

test("configures native ARM64 and x64 desktop release targets", async () => {
  const desktopPackage = JSON.parse(
    await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  );
  const releaseWorkflow = await readFile(
    new URL("../.github/workflows/desktop-release.yml", import.meta.url),
    "utf8",
  );
  const packageSmokeWorkflow = await readFile(
    new URL("../.github/workflows/desktop-package-smoke.yml", import.meta.url),
    "utf8",
  );
  const downloadPage = await readFile(new URL("../downloads/index.html", import.meta.url), "utf8");
  const targetArchitectures = (platform) =>
    desktopPackage.build[platform].target.map(({ arch, target }) => [target, arch]);

  assert.deepEqual(targetArchitectures("win"), [["nsis", ["x64", "arm64"]]]);
  assert.deepEqual(targetArchitectures("linux"), [
    ["AppImage", ["x64", "arm64"]],
    ["deb", ["x64", "arm64"]],
  ]);
  assert.match(desktopPackage.scripts["package:win"], /--x64 --arm64/u);
  assert.match(desktopPackage.scripts["package:linux"], /--x64 --arm64/u);
  assert.match(desktopPackage.scripts["package:win:arm64"], /--win nsis:arm64/u);
  assert.match(desktopPackage.scripts["package:linux:arm64"], /--linux AppImage:arm64 deb:arm64/u);
  assert.equal(desktopPackage.build.nsis.buildUniversalInstaller, false);
  assert.match(
    releaseWorkflow,
    /runs-on: \[self-hosted, Linux, ARM64, hmm-chat-release, docker\]/u,
  );
  assert.match(
    packageSmokeWorkflow,
    /runner: '\["self-hosted", "Linux", "X64", "docker", "docker-mac-mini"\]'/u,
  );
  assert.doesNotMatch(
    packageSmokeWorkflow,
    /runner: '\["self-hosted", "Linux", "X64", "hmm-chat-release"/u,
  );
  assert.equal(releaseWorkflow.match(/UPDATE_MANIFEST: latest-linux-arm64\.yml/gu)?.length, 4);
  assert.doesNotMatch(releaseWorkflow, /actions\/(?:upload|download)-artifact/u);
  assert.match(releaseWorkflow, /name: Prepare GitHub Release[\s\S]*contents: write/u);
  const stagingIndex = releaseWorkflow.indexOf("Stage GitHub Release assets");
  const publicationGuardIndex = releaseWorkflow.indexOf(
    "Refuse to overwrite a published platform version",
  );
  assert.ok(
    stagingIndex >= 0 && stagingIndex < publicationGuardIndex,
    "GitHub Release assets must be staged before the public feed publication guard",
  );
  assert.match(releaseWorkflow, /name: Wait for all GitHub Release assets[\s\S]*seq 1 60/u);
  assert.match(releaseWorkflow, /name: Publish GitHub Release[\s\S]*contents: write/u);
  assert.match(releaseWorkflow, /gh release create[\s\S]*--generate-notes/u);
  assert.match(releaseWorkflow, /gh release upload[\s\S]*--clobber/u);
  assert.match(downloadPage, /"latest-linux-arm64\.yml"/u);
});

test("parses quoted and unquoted manifest versions", () => {
  assert.equal(parseManifestVersion("version: 1.2.3\n"), "1.2.3");
  assert.equal(parseManifestVersion('version: "1.2.3"\n'), "1.2.3");
  assert.throws(() => parseManifestVersion("path: app.zip\n"), /no valid version/);
});

test("binds every manifest artifact URL and path to its SHA-512", () => {
  const manifest = [
    "version: 1.2.3",
    "files:",
    "  - url: hype-comms-1.2.3-mac-arm64.zip",
    "    sha512: arm+/=",
    "    size: 123",
    "  - url: hype-comms-1.2.3-mac-x64.zip",
    "    sha512: intel+/=",
    "    size: 456",
    "path: hype-comms-1.2.3-mac-arm64.zip",
    "sha512: arm+/=",
    "",
  ].join("\n");

  const cacheKeyedManifest = addArtifactCacheKeys(manifest);

  assert.match(cacheKeyedManifest, /url: hype-comms-1\.2\.3-mac-arm64\.zip\?sha512=arm%2B%2F%3D/u);
  assert.match(cacheKeyedManifest, /url: hype-comms-1\.2\.3-mac-x64\.zip\?sha512=intel%2B%2F%3D/u);
  assert.match(cacheKeyedManifest, /path: hype-comms-1\.2\.3-mac-arm64\.zip\?sha512=arm%2B%2F%3D/u);
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
        file("hype-comms-1.2.3-win-arm64.exe.blockmap"),
        file("hype-comms-1.2.3-linux-arm64.AppImage"),
        file("hype-comms-1.2.3-linux-arm64.deb"),
        file("hype-comms-1.2.3-linux-x64.AppImage"),
        file("hype-comms-1.2.3-linux-x64.deb"),
        directory("hype-comms-1.2.3-win-unpacked"),
        file("hype-comms-1.2.3-win-arm64.exe"),
      ],
      "1.2.3",
      "win",
    ),
    ["hype-comms-1.2.3-win-arm64.exe", "hype-comms-1.2.3-win-arm64.exe.blockmap"],
  );
  assert.deepEqual(
    selectArtifactNames(
      [
        file("hype-comms-1.2.3-linux-arm64.AppImage"),
        file("hype-comms-1.2.3-linux-arm64.deb"),
        file("hype-comms-1.2.3-linux-x64.AppImage"),
        file("hype-comms-1.2.3-linux-x64.deb"),
        file("hype-comms-1.2.4-linux-arm64.AppImage"),
      ],
      "1.2.3",
      "linux",
    ),
    [
      "hype-comms-1.2.3-linux-arm64.AppImage",
      "hype-comms-1.2.3-linux-arm64.deb",
      "hype-comms-1.2.3-linux-x64.AppImage",
      "hype-comms-1.2.3-linux-x64.deb",
    ],
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

test("lets a manifest published before the commit marker be replaced on retry", async () => {
  const resumable = { ...environment, ALLOW_REPUBLISH: "true" };

  await assertVersionCanPublish({
    environment: resumable,
    fetchImplementation: async () => new Response("version: 1.2.3\n"),
  });
  await assert.rejects(
    assertVersionCanPublish({
      environment: resumable,
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
