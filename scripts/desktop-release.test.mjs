import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addArtifactCacheKeys,
  assertVersionCanPublish,
  cacheKeyPlatformManifest,
  missingGithubReleaseAssets,
  parseManifestVersion,
  runAws,
  runAwsWithRetry,
  selectArtifactNames,
  uploadPlatformManifest,
  waitForGithubReleaseAssets,
} from "./desktop-release-helpers.mjs";
import { releaseBodyStartsWithReviewedNotes } from "./desktop-release-notes.mjs";

const workflowJob = (workflow, jobName) => {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Expected workflow job ${jobName}`);

  const remainingWorkflow = workflow.slice(start + marker.length);
  const nextJob = remainingWorkflow.search(/^ {2}[a-zA-Z0-9_-]+:\n/mu);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + nextJob);
};

const environment = {
  DESKTOP_VERSION: "1.2.3",
  GH_TOKEN: "test-token",
  GITHUB_API_URL: "https://api.github.example",
  GITHUB_REF_NAME: "v1.2.3",
  GITHUB_REPOSITORY: "example/hype-comms",
  HYPE_COMMS_UPDATE_PUBLIC_ROOT: "https://updates.example/desktop",
  HYPE_COMMS_UPDATE_S3_BUCKET: "updates",
  HYPE_COMMS_UPDATE_S3_ENDPOINT: "https://s3.example",
  RUNNER_TEMP: path.join(os.tmpdir(), "hype-comms-runner"),
  UPDATE_ARTIFACT_OS: "win",
  UPDATE_MANIFEST: "latest.yml",
};

const workflowJob = (workflow, jobName) => {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Expected workflow job ${jobName}`);
  const remainingWorkflow = workflow.slice(start + marker.length);
  const nextJob = remainingWorkflow.search(/^ {2}[a-zA-Z0-9_-]+:\n/mu);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + nextJob);
};

const matrixEntry = (job, platform) => {
  const marker = `          - platform: ${platform}\n`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `Expected matrix entry for ${platform}`);
  const remainingJob = job.slice(start + marker.length);
  const nextEntry = remainingJob.search(/^ {10}- platform: /mu);
  const matrixEnd = remainingJob.search(/^ {4}runs-on:/mu);
  const endCandidates = [nextEntry, matrixEnd].filter((index) => index >= 0);
  assert.ok(endCandidates.length > 0, `Expected matrix entry boundary for ${platform}`);
  return job.slice(start, start + marker.length + Math.min(...endCandidates));
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
  const releasePackageJob = workflowJob(releaseWorkflow, "package");
  const smokePackageJob = workflowJob(packageSmokeWorkflow, "package");
  const nativeEvidenceJob = workflowJob(packageSmokeWorkflow, "macos-native-notification-evidence");
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
  assert.equal(desktopPackage.build.artifactName, "hype-comms-${version}-${os}-${arch}.${ext}");
  assert.match(
    releaseWorkflow,
    /^concurrency:\n[ ]{2}# [^\n]+\n[ ]{2}# [^\n]+\n[ ]{2}group: desktop-release-publish\n[ ]{2}cancel-in-progress: false$/mu,
  );
  assert.doesNotMatch(releaseWorkflow, /^[ ]{2}group: desktop-release$/mu);
  assert.match(
    releaseWorkflow,
    /runs-on: \[self-hosted, Linux, ARM64, hype-comms-release, docker\]/u,
  );
  assert.match(
    releaseWorkflow,
    /^ {2}prepare-github-release:[\s\S]*?^ {4}runs-on: \[self-hosted, Linux, ARM64, hype-comms-release, docker\]/mu,
  );
  assert.match(
    releaseWorkflow,
    /^ {2}github-release:[\s\S]*?^ {4}runs-on: \[self-hosted, Linux, ARM64, hype-comms-release, docker\]/mu,
  );
  assert.doesNotMatch(releaseWorkflow, /runs-on: ubuntu-latest/u);
  assert.match(
    matrixEntry(releasePackageJob, "macOS"),
    /^ {12}native_notifications_enabled: "1"$/mu,
  );
  assert.match(
    matrixEntry(releasePackageJob, "Windows"),
    /^ {12}native_notifications_enabled: "0"$/mu,
  );
  assert.match(
    matrixEntry(releasePackageJob, "Linux"),
    /^ {12}native_notifications_enabled: "0"$/mu,
  );
  assert.match(
    releasePackageJob,
    /^ {6}HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED: \$\{\{ matrix\.native_notifications_enabled \}\}$/mu,
  );
  assert.equal(releaseWorkflow.match(/node scripts\/install-github-cli\.mjs/gu)?.length, 4);
  assert.match(
    releaseWorkflow,
    /^ {2}prepare-github-release:[\s\S]*?node scripts\/install-github-cli\.mjs[\s\S]*?gh release create/mu,
  );
  assert.match(
    releaseWorkflow,
    /^ {2}package:[\s\S]*?node scripts\/install-github-cli\.mjs[\s\S]*?gh release upload/mu,
  );
  assert.match(
    releaseWorkflow,
    /^ {2}github-release:[\s\S]*?node scripts\/install-github-cli\.mjs[\s\S]*?gh release edit/mu,
  );
  assert.match(
    packageSmokeWorkflow,
    /runner: '\["self-hosted", "Linux", "ARM64", "hype-comms-release", "docker"\]'/u,
  );
  assert.equal(
    packageSmokeWorkflow.match(/^ {6}- \.github\/workflows\/desktop-release\.yml$/gmu)?.length,
    2,
  );
  assert.equal(
    packageSmokeWorkflow.match(/^ {6}- scripts\/capture-macos-native-notification\.mjs$/gmu)
      ?.length,
    2,
  );
  assert.equal(
    packageSmokeWorkflow.match(
      /^ {6}- scripts\/macos-native-notification-evidence-helper\.swift$/gmu,
    )?.length,
    2,
  );
  assert.match(matrixEntry(smokePackageJob, "macOS"), /^ {12}native_notifications_enabled: "1"$/mu);
  assert.match(
    matrixEntry(smokePackageJob, "Windows"),
    /^ {12}native_notifications_enabled: "0"$/mu,
  );
  assert.match(matrixEntry(smokePackageJob, "Linux"), /^ {12}native_notifications_enabled: "0"$/mu);
  assert.match(
    smokePackageJob,
    /^ {6}HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED: \$\{\{ matrix\.native_notifications_enabled \}\}$/mu,
  );
  assert.match(
    packageSmokeWorkflow,
    /^ {6}native_notification_evidence:\n {8}description: .+\n {8}required: false\n {8}default: false\n {8}type: boolean$/mu,
  );
  assert.match(
    nativeEvidenceJob,
    /^ {4}if: github\.event_name == 'workflow_dispatch' && inputs\.native_notification_evidence$/mu,
  );
  assert.match(
    nativeEvidenceJob,
    /^ {6}HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED: "1"\n {6}HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_ENABLED: "1"$/mu,
  );
  assert.match(nativeEvidenceJob, /npm run package:desktop:mac/u);
  assert.match(nativeEvidenceJob, /npm run verify:desktop-package:macos-release/u);
  assert.match(nativeEvidenceJob, /name: Build and authorize signed macOS evidence helper/u);
  assert.match(nativeEvidenceJob, /"\$notification_helper_executable" notification-request &/u);
  assert.match(
    nativeEvidenceJob,
    /CFBundleIdentifier string com\.hypotheticalmoneymachine\.hmmchat'/u,
  );
  assert.match(nativeEvidenceJob, /"\$notification_helper_executable" notification-preflight/u);
  assert.match(nativeEvidenceJob, /"\$helper_executable" request/u);
  assert.match(nativeEvidenceJob, /"\$helper_executable" preflight/u);
  assert.match(nativeEvidenceJob, /node scripts\/capture-macos-native-notification\.mjs/u);
  assert.match(nativeEvidenceJob, /--helper="\$HMM_MACOS_NATIVE_NOTIFICATION_EVIDENCE_HELPER"/u);
  assert.match(
    nativeEvidenceJob,
    /--notification-helper="\$HMM_MACOS_NATIVE_NOTIFICATION_AUTHORIZATION_HELPER"/u,
  );
  assert.match(nativeEvidenceJob, /name: macos-native-notification-evidence/u);
  assert.doesNotMatch(packageSmokeWorkflow, /runner: '\["self-hosted", "Linux", "X64"/u);
  assert.match(packageSmokeWorkflow, /Verify native Linux ARM64 runner[\s\S]*uname -m/u);
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
  assert.match(
    releaseWorkflow,
    /name: Wait for all GitHub Release assets[\s\S]*run: node scripts\/desktop-release\.mjs wait-github-assets/u,
  );
  assert.doesNotMatch(releaseWorkflow, /\$\(\s*seq\b/u);
  assert.match(releaseWorkflow, /name: Publish GitHub Release[\s\S]*contents: write/u);
  assert.match(releaseWorkflow, /gh release upload[\s\S]*--clobber/u);
  assert.match(
    releaseWorkflow,
    /apps\/desktop\/release\/hype-comms-\$\{\{ needs\.validate\.outputs\.desktop-version \}\}-\$\{\{ matrix\.artifact_os \}\}-\*/u,
  );
  assert.equal(
    releaseWorkflow.match(/"hype-comms-\$\{DESKTOP_VERSION\}-(?:mac|win|linux)-"/gu)?.length,
    3,
  );
  assert.doesNotMatch(releaseWorkflow, /hmm-chat-\$\{(?:DESKTOP_VERSION|\{)/u);
  assert.match(downloadPage, /"latest-linux-arm64\.yml"/u);
});

test("requires reviewed Hype Comms notes before publishing a desktop release", async () => {
  const [releaseWorkflow, releaseNotesGuide] = await Promise.all([
    readFile(new URL("../.github/workflows/desktop-release.yml", import.meta.url), "utf8"),
    readFile(new URL("../docs/releases/README.md", import.meta.url), "utf8"),
  ]);
  const validateJob = workflowJob(releaseWorkflow, "validate");
  const prepareJob = workflowJob(releaseWorkflow, "prepare-github-release");
  const publishJob = workflowJob(releaseWorkflow, "github-release");

  assert.match(validateJob, /release_notes_path="docs\/releases\/\$\{GITHUB_REF_NAME\}\.md"/u);
  const missingNotesFileGuard = validateJob.indexOf('[[ ! -f "$release_notes_path" ]]');
  const emptyNotesFileGuard = validateJob.indexOf(`! grep -q '[^[:space:]]' "$release_notes_path"`);
  assert.match(validateJob, /\[\[ -L "\$release_notes_path" \]\]/u);
  assert.ok(missingNotesFileGuard >= 0, "release notes file must exist");
  assert.ok(emptyNotesFileGuard > missingNotesFileGuard, "release notes file must not be empty");
  assert.match(validateJob, /grep -Fq '<!-- release-notes:todo' "\$release_notes_path"/u);
  assert.match(
    prepareJob,
    /RELEASE_NOTES_FALLBACK_TAG: v0\.1\.11[\s\S]*gh release list[\s\S]*--exclude-drafts[\s\S]*gh release create[\s\S]*--title "Hype Comms \$\{DESKTOP_VERSION\}"[\s\S]*--notes-file "\$release_notes_path"[\s\S]*--generate-notes[\s\S]*--notes-start-tag/u,
  );
  assert.match(prepareJob, /gh release view[\s\S]*--json body[\s\S]*> "\$release_body_path"/u);
  const prepareNotesCheck = prepareJob.indexOf("node scripts/desktop-release-notes.mjs");
  const repairRelease = prepareJob.indexOf("gh release edit");
  assert.ok(prepareNotesCheck >= 0, "existing release notes must be checked");
  assert.ok(repairRelease > prepareNotesCheck, "an invalid existing body must be repaired");
  assert.match(
    prepareJob,
    /printf '%s\\n' "\$release_notes"[\s\S]*cat "\$release_body_path"[\s\S]*--notes-file "\$combined_notes_path"/u,
  );
  assert.doesNotMatch(prepareJob, /printf [^\n]*\|[ ]*grep -q/u);
  assert.doesNotMatch(prepareJob, /HMM Chat/u);

  assert.match(publishJob, /gh release view[\s\S]*--json body[\s\S]*> "\$release_body_path"/u);
  assert.match(publishJob, /node scripts\/desktop-release-notes\.mjs/u);
  assert.doesNotMatch(publishJob, /printf [^\n]*\|[ ]*grep -q/u);
  const reviewedNotesGuard = publishJob.indexOf("node scripts/desktop-release-notes.mjs");
  const publishRelease = publishJob.indexOf("--draft=false");
  assert.ok(reviewedNotesGuard >= 0, "GitHub Release publication must require reviewed notes");
  assert.ok(
    publishRelease > reviewedNotesGuard,
    "GitHub Release notes must be checked before the draft is published",
  );
  assert.match(publishJob, /--title "Hype Comms \$\{DESKTOP_VERSION\}"/u);
  assert.doesNotMatch(publishJob, /HMM Chat/u);
  assert.match(releaseNotesGuide, /docs\/releases\/v<version>\.md/u);
  assert.match(releaseNotesGuide, /user-facing notes/u);
});

test("requires the reviewed notes to end at a release-body boundary", () => {
  const reviewedNotes = "## Fix";

  assert.equal(releaseBodyStartsWithReviewedNotes(reviewedNotes, reviewedNotes), true);
  assert.equal(
    releaseBodyStartsWithReviewedNotes(`${reviewedNotes}\n`, `${reviewedNotes}\n`),
    true,
  );
  assert.equal(
    releaseBodyStartsWithReviewedNotes(reviewedNotes, `${reviewedNotes}\n\n## What's Changed`),
    true,
  );
  assert.equal(releaseBodyStartsWithReviewedNotes(reviewedNotes, "## Fixes\n"), false);
  assert.equal(releaseBodyStartsWithReviewedNotes(" \n", " \n"), false);
});

test("checks reviewed release notes without installed package dependencies", async () => {
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "hype-comms-release-notes-"));
  try {
    const isolatedScript = path.join(isolatedRoot, "desktop-release-notes.mjs");
    const reviewedNotesPath = path.join(isolatedRoot, "reviewed.md");
    const releaseBodyPath = path.join(isolatedRoot, "release-body.md");
    await Promise.all([
      writeFile(
        isolatedScript,
        await readFile(new URL("./desktop-release-notes.mjs", import.meta.url), "utf8"),
      ),
      writeFile(reviewedNotesPath, "## Highlights\n\n- Reviewed.\n"),
      writeFile(releaseBodyPath, "## Highlights\n\n- Reviewed.\n\n## What's Changed\n"),
    ]);

    const result = spawnSync(process.execPath, [isolatedScript], {
      encoding: "utf8",
      env: {
        GITHUB_RELEASE_BODY_PATH: releaseBodyPath,
        RELEASE_NOTES_PATH: reviewedNotesPath,
      },
      shell: false,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    await rm(isolatedRoot, { force: true, recursive: true });
  }
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
  const releaseDirectory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-release-"));
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

test("waits for every GitHub Release asset without shell utilities", async () => {
  const completeAssets = [
    "latest-mac.yml",
    "latest.yml",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
    "hype-comms-1.2.3-mac-arm64.zip",
    "hype-comms-1.2.3-win-x64.exe",
    "hype-comms-1.2.3-linux-arm64.AppImage",
  ];
  const responses = [completeAssets.slice(0, -1), completeAssets];
  const requests = [];
  const delays = [];

  await waitForGithubReleaseAssets({
    attempts: 2,
    delayMilliseconds: 25,
    environment,
    fetchImplementation: async (url, options) => {
      requests.push({ options, url: url.href });
      return Response.json([
        { assets: [], tag_name: "v1.2.2" },
        {
          assets: responses.shift().map((name) => ({ name })),
          tag_name: "v1.2.3",
        },
      ]);
    },
    sleep(milliseconds) {
      delays.push(milliseconds);
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    "https://api.github.example/repos/example/hype-comms/releases?per_page=100",
  );
  assert.equal(requests[0].options.headers.authorization, "Bearer test-token");
  assert.deepEqual(delays, [25]);
  assert.deepEqual(missingGithubReleaseAssets(completeAssets, "1.2.3"), []);
});

test("bounds GitHub Release asset polling and validates the response", async () => {
  const delays = [];
  await assert.rejects(
    waitForGithubReleaseAssets({
      attempts: 2,
      delayMilliseconds: 5,
      environment,
      fetchImplementation: async () => Response.json([{ assets: [], tag_name: "v1.2.3" }]),
      sleep(milliseconds) {
        delays.push(milliseconds);
      },
    }),
    /Missing: latest-mac\.yml, latest\.yml, latest-linux\.yml, latest-linux-arm64\.yml/,
  );
  assert.deepEqual(delays, [5]);

  await assert.rejects(
    waitForGithubReleaseAssets({
      attempts: 1,
      environment,
      fetchImplementation: async () =>
        Response.json([{ assets: [{ name: 42 }], tag_name: "v1.2.3" }]),
    }),
    /assets must have non-empty string names/,
  );
  await assert.rejects(
    waitForGithubReleaseAssets({
      attempts: 1,
      environment,
      fetchImplementation: async () => Response.json([{ assets: [], tag_name: "v1.2.2" }]),
    }),
    /does not contain draft tag v1\.2\.3/,
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
    path.join(environment.RUNNER_TEMP, "hype-comms-aws-config"),
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
  const releaseDirectory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-release-"));
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
