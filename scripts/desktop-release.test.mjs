import { OFFICIAL_PRODUCTION_API_ORIGIN } from "../apps/desktop/src/shared/api-origin.ts";
import {
  commands,
  readWorkflow,
  stepBefore,
  workflowJob,
  workflowStep,
} from "./workflow-test-support.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createElectronBuilderConfiguration } from "../apps/desktop/electron-builder.config.mjs";
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
import { releaseBodyStartsWithReviewedNotes } from "./desktop-release-notes.mjs";

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

test("keeps release and smoke targets, trust boundaries and platform notification scope", async () => {
  const desktopPackage = JSON.parse(
    await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  );
  const build = createElectronBuilderConfiguration("production");
  const release = await readWorkflow("desktop-release.yml");
  const smoke = await readWorkflow("desktop-package-smoke.yml");
  const validation = workflowJob(release, "validate");
  const prepare = workflowJob(release, "prepare-github-release");
  const packaging = workflowJob(release, "package");
  const publication = workflowJob(release, "github-release");
  const smokePackage = workflowJob(smoke, "package");
  const native = workflowJob(smoke, "macos-native-notification-evidence");
  const platforms = ["macOS", "Windows", "Linux"];
  const releaseRunners = [["macos-15"], ["windows-11-arm"], ["ubuntu-24.04-arm"]];
  const hostedRunners = [
    ["self-hosted", "macOS", "ARM64", "notarize"],
    ["self-hosted", "Windows", "ARM64", "windows-release"],
    ["self-hosted", "Linux", "ARM64", "hype-comms-release", "docker"],
  ];
  const entry = (job, platform) => {
    const matches = job.strategy.matrix.include.filter((row) => row.platform === platform);
    assert.equal(matches.length, 1);
    return matches[0];
  };
  assert.deepEqual(
    build.win.target.map(({ arch, target }) => [target, arch]),
    [["nsis", ["x64", "arm64"]]],
  );
  assert.deepEqual(
    build.linux.target.map(({ arch, target }) => [target, arch]),
    [
      ["AppImage", ["x64", "arm64"]],
      ["deb", ["x64", "arm64"]],
    ],
  );
  assert.equal(build.nsis.buildUniversalInstaller, false);
  assert.equal(build.artifactName, "hype-comms-${version}-${os}-${arch}.${ext}");
  assert.deepEqual(build.mac.extraResources, [
    {
      from: "native-build/macos/hmm-notification-authorization.node",
      to: "hmm-notification-authorization.node",
    },
  ]);
  for (const command of Object.values(desktopPackage.scripts).filter((value) =>
    value.includes("electron-builder"),
  ))
    assert.match(command, /--config electron-builder\.config\.mjs/u);
  for (const name of ["package", "package:mac", "package:mac:arm64"])
    assert.match(desktopPackage.scripts[name], /build-macos-notification-authorization\.mjs/u);
  assert.match(
    desktopPackage.scripts["package:mac:arm64"],
    /--mac dmg:arm64 zip:arm64 --publish never$/u,
  );
  assert.match(desktopPackage.scripts["package:win:arm64"], /--win nsis:arm64/u);
  assert.match(desktopPackage.scripts["package:linux:arm64"], /--linux AppImage:arm64 deb:arm64/u);
  assert.deepEqual(release.concurrency, {
    group: "desktop-release-publish",
    "cancel-in-progress": false,
  });
  assert.deepEqual(release.env, {
    HYPE_COMMS_BUILD_FLAVOR: "production",
    HYPE_COMMS_API_ORIGIN: OFFICIAL_PRODUCTION_API_ORIGIN,
  });
  assert.deepEqual(smoke.on.merge_group.types, ["checks_requested"]);
  assert.deepEqual(smoke.permissions, { contents: "read" });
  for (const [index, platform] of platforms.entries()) {
    assert.deepEqual(JSON.parse(entry(packaging, platform).runner), releaseRunners[index]);
    assert.equal(
      entry(smokePackage, platform).runner,
      `\${{ github.event_name == 'workflow_dispatch' && '${JSON.stringify(hostedRunners[index]).replaceAll(",", ", ")}' || '${JSON.stringify(releaseRunners[index])}' }}`,
    );
    assert.equal(
      entry(smokePackage, platform).self_hosted,
      "${{ github.event_name == 'workflow_dispatch' }}",
    );
    for (const job of [packaging, smokePackage])
      assert.equal(
        entry(job, platform).native_notifications_enabled,
        platform === "macOS" ? "1" : "0",
      );
  }
  for (const job of [packaging, smokePackage])
    assert.equal(
      job.env.HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED,
      "${{ matrix.native_notifications_enabled }}",
    );
  for (const job of [validation, prepare, publication])
    assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.deepEqual(validation.permissions, { contents: "read" });
  assert.equal(publication.environment, "release");
  assert.deepEqual(
    Object.entries(release.jobs)
      .filter(([, job]) => job.environment === "release")
      .map(([name]) => name),
    ["github-release"],
  );
  assert.equal(prepare.environment, undefined);
  assert.equal(packaging.environment, undefined);
  assert.equal(smokePackage.environment, undefined);
  assert.doesNotMatch(JSON.stringify(packaging), /self-hosted|GARAGE_(?:ACCESS|SECRET)_/u);
  assert.doesNotMatch(JSON.stringify(smokePackage), /head\.repo\.full_name|secrets\./u);
  assert.doesNotMatch(
    JSON.stringify(release),
    /ubuntu-latest|actions\/(?:upload|download)-artifact/u,
  );
  const releaseCache = packaging.steps.find((step) =>
    step.uses?.startsWith("actions/cache/restore@"),
  );
  const smokeCache = workflowStep(smokePackage, "Restore desktop dependency downloads");
  assert.equal(
    releaseCache?.uses,
    "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  );
  assert.ok(!packaging.steps.some((step) => step.uses?.startsWith("actions/cache@")));
  assert.equal(smokeCache.uses, "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
  assert.equal(smokeCache.if, "${{ !matrix.self_hosted }}");
  for (const cache of [releaseCache, smokeCache])
    assert.equal(
      cache.with.key,
      "desktop-downloads-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}",
    );
  for (const job of [packaging, smokePackage]) {
    assert.doesNotMatch(JSON.stringify(job), /node_modules\\n/u);
    assert.equal((commands(job).match(/npm ci --no-audit --prefer-offline/gu) ?? []).length, 2);
  }
  for (const file of [
    ".github/workflows/desktop-release.yml",
    "packages/api-client/**",
    "tsconfig*.json",
    "scripts/desktop-release.mjs",
    "scripts/desktop-release-validation.mjs",
    "scripts/macos-signing.mjs",
    "scripts/verify-zod-alignment.mjs",
    "scripts/require-windows-signing-env.mjs",
    "scripts/verify-windows-release.mjs",
    "scripts/capture-macos-native-notification.mjs",
    "scripts/build-macos-notification-authorization.mjs",
    "scripts/macos-native-notification-evidence-helper.swift",
  ]) {
    for (const trigger of ["push", "pull_request"])
      assert.ok(smoke.on[trigger].paths.includes(file));
  }
  assert.equal(smokePackage.env.HYPE_COMMS_BUILD_FLAVOR, undefined);
  assert.equal(
    workflowStep(smokePackage, "Package DEV desktop application").env.CSC_FOR_PULL_REQUEST,
    "${{ matrix.platform == 'macOS' && !matrix.self_hosted && 'true' || 'false' }}",
  );
  for (const [name, command] of [
    ["Package production desktop application on Linux", "npm run package:desktop:linux"],
    ["Verify production desktop package on Linux", "npm run verify:desktop-package"],
  ]) {
    const step = workflowStep(smokePackage, name);
    assert.equal(step.if, "matrix.platform == 'Linux'");
    assert.equal(step.run, command);
    assert.deepEqual(step.env, release.env);
  }
  assert.equal(
    workflowStep(validation, "Require a tag matching the desktop package version").run,
    "node scripts/desktop-release.mjs validate-version",
  );
  assert.equal(
    workflowStep(packaging, "Configure macOS signing and notarization").run,
    "node scripts/desktop-release.mjs configure-macos-signing",
  );
  const cleanup = workflowStep(packaging, "Remove temporary macOS signing keychain");
  assert.equal(cleanup.if, "always() && matrix.platform == 'macOS'");
  assert.equal(cleanup.run, "node scripts/desktop-release.mjs cleanup-macos-signing");
  for (const [first, second] of [
    ["Configure Windows Authenticode signing", "Package desktop application on Windows"],
    ["Package desktop application on Windows", "Verify Windows release signing"],
    ["Verify Windows release signing", "Stage GitHub Release assets"],
  ])
    stepBefore(packaging, first, second);
  const windows = workflowStep(packaging, "Configure Windows Authenticode signing");
  assert.equal(windows.run, "node scripts/require-windows-signing-env.mjs");
  for (const name of [
    "HYPE_COMMS_WINDOWS_AZURE_TENANT_ID",
    "HYPE_COMMS_WINDOWS_AZURE_CLIENT_ID",
    "HYPE_COMMS_WINDOWS_AZURE_CLIENT_SECRET",
  ])
    assert.equal(windows.env[name], `\${{ secrets.${name} }}`);
  for (const name of [
    "HYPE_COMMS_WINDOWS_AZURE_ENDPOINT",
    "HYPE_COMMS_WINDOWS_AZURE_CODE_SIGNING_ACCOUNT_NAME",
    "HYPE_COMMS_WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME",
    "HYPE_COMMS_WINDOWS_PUBLISHER_NAME",
  ])
    assert.equal(windows.env[name], `\${{ vars.${name} }}`);
  const verifyWindows = workflowStep(packaging, "Verify Windows release signing");
  assert.equal(
    verifyWindows.if,
    "matrix.platform == 'Windows' && env.HYPE_COMMS_WINDOWS_SIGNING_ENABLED == 'true'",
  );
  assert.match(verifyWindows.run, /npm run verify:desktop-package:windows-release/u);
  assert.equal(smoke.on.workflow_dispatch.inputs.native_notification_evidence.type, "boolean");
  assert.equal(smoke.on.workflow_dispatch.inputs.native_notification_evidence.default, false);
  assert.equal(smoke.on.workflow_dispatch.inputs.native_notification_evidence.required, false);
  assert.equal(native.environment, "release");
  const nativeSigning = workflowStep(native, "Configure macOS signing and notarization");
  assert.equal(nativeSigning.run, "node scripts/desktop-release.mjs configure-macos-signing");
  assert.deepEqual(
    nativeSigning.env,
    workflowStep(packaging, "Configure macOS signing and notarization").env,
  );
  const nativeCleanup = workflowStep(native, "Remove temporary macOS signing keychain");
  assert.equal(nativeCleanup.if, "always()");
  assert.equal(nativeCleanup.run, "node scripts/desktop-release.mjs cleanup-macos-signing");
  stepBefore(
    native,
    "Configure macOS signing and notarization",
    "Build signed macOS capture helper",
  );
  const helper = workflowStep(native, "Build signed macOS capture helper").run;
  for (const requirement of [
    "scripts/macos-native-notification-evidence-helper.swift",
    "-framework ScreenCaptureKit",
    "Add :LSUIElement bool true",
    "Add :NSScreenCaptureUsageDescription",
    '--sign "$CSC_NAME"',
    '--keychain "$CSC_KEYCHAIN"',
    "--options runtime",
    "--timestamp",
    "/usr/bin/codesign --verify --deep --strict",
  ]) {
    assert.ok(helper.includes(requirement), requirement);
  }

  assert.equal(
    native.if,
    "github.event_name == 'workflow_dispatch' && inputs.native_notification_evidence",
  );
  assert.equal(native.env.HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED, "1");
  assert.equal(
    native.env.HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_ENABLED,
    "${{ inputs.native_notification_evidence && '1' || '0' }}",
  );
  for (const [name, value] of Object.entries(release.env)) assert.equal(native.env[name], value);
  assert.match(commands(native), /npm run package:desktop:mac:arm64/u);
  assert.match(commands(native), /npm run verify:desktop-package:macos-release/u);
  assert.equal((commands(native).match(/npm ci --no-audit --prefer-offline/gu) ?? []).length, 1);
  assert.match(
    workflowStep(native, "Verify packaged application contents, updater, and fuses").run,
    /npm run verify:desktop-package/u,
  );
  stepBefore(
    native,
    "Verify macOS release signing and notarization",
    "Await unlocked console and authorize macOS capture helper",
  );
  for (const name of [
    "Build signed macOS capture helper",
    "Capture installed notification and click callback",
  ])
    assert.equal(workflowStep(native, name).if, "inputs.native_notification_evidence");
  assert.doesNotMatch(commands(native), /caffeinate|notification_helper_bundle/u);
  assert.match(commands(native), /\/usr\/bin\/open -W -n "\$helper_bundle" --args request &/u);
  assert.match(commands(native), /"\$helper_executable" preflight/u);
  assert.match(commands(native), /node scripts\/capture-macos-native-notification\.mjs/u);
  assert.match(
    commands(native),
    /--helper="\$HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_HELPER"/u,
  );
  const evidenceUpload = native.steps.find(
    (step) => step.with?.name === "macos-native-notification-evidence",
  );
  assert.deepEqual(
    evidenceUpload.with.path.trim().split("\n"),
    [
      "automation.log",
      "application.log",
      "delivered.json",
      "clicked.json",
      "failed.json",
      "macos-native-notification.png",
      "macos-native-notification-clicked.png",
    ].map((name) => `\${{ env.HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_DIRECTORY }}/${name}`),
  );
  assert.doesNotMatch(JSON.stringify(native), /\/user-data|secrets\.HMM_MACOS_/u);
  for (const name of [
    "HYPE_COMMS_MACOS_CSC_LINK",
    "HYPE_COMMS_MACOS_CSC_KEY_PASSWORD",
    "HYPE_COMMS_MACOS_APPLE_API_KEY_BASE64",
    "HYPE_COMMS_MACOS_APPLE_API_KEY_ID",
    "HYPE_COMMS_MACOS_APPLE_API_ISSUER",
  ])
    assert.ok(JSON.stringify(native).includes(`secrets.${name}`));
  assert.match(workflowStep(smokePackage, "Verify native Linux ARM64 runner").run, /uname -m/u);
  assert.equal(
    Object.values(release.jobs)
      .flatMap((job) => job.steps)
      .filter((step) => step.run?.includes("node scripts/install-github-cli.mjs")).length,
    4,
  );
  for (const [job, action] of [
    [prepare, "gh release create"],
    [packaging, "gh release upload"],
    [publication, "gh release edit"],
  ]) {
    const install = job.steps.findIndex((step) =>
      step.run?.includes("node scripts/install-github-cli.mjs"),
    );
    const use = job.steps.findIndex((step) => step.run?.includes(action));
    assert.ok(install >= 0 && use > install);
  }
  assert.equal(prepare.permissions.contents, "write");
  assert.equal(publication.permissions.contents, "write");
  assert.ok(publication.needs.includes("package"));
  assert.doesNotMatch(commands(publication), /wait-github-assets|\$\(\s*seq\b/u);
  assert.match(
    workflowStep(publication, "Download staged release assets").run,
    /gh release download[\s\S]*--dir apps\/desktop\/release/u,
  );
  assert.match(
    workflowStep(publication, "Publish and verify Linux ARM64 update manifest").run,
    /node scripts\/desktop-release\.mjs upload-manifest[\s\S]*node scripts\/verify-published-desktop-release\.mjs/u,
  );
  assert.match(
    workflowStep(publication, "Publish and verify platform update manifests").run,
    /for target in mac:latest-mac\.yml win:latest\.yml linux:latest-linux\.yml/u,
  );
  assert.equal(
    Object.values(release.jobs)
      .flatMap((job) => job.steps)
      .filter((step) => step.env?.UPDATE_MANIFEST === "latest-linux-arm64.yml").length,
    2,
  );
  assert.match(
    workflowStep(packaging, "Stage GitHub Release assets").run,
    /gh release upload[\s\S]*--clobber/u,
  );
  const downloadPage = await readFile(new URL("../downloads/index.html", import.meta.url), "utf8");
  assert.match(downloadPage, /"latest-linux-arm64\.yml"/u);
});

test("requires reviewed notes before creating or publishing the release", async () => {
  const workflow = await readWorkflow("desktop-release.yml");
  const prepare = commands(workflowJob(workflow, "prepare-github-release"));
  const publish = commands(workflowJob(workflow, "github-release"));
  assert.match(
    prepare,
    /gh release list[\s\S]*--exclude-drafts[\s\S]*gh release create[\s\S]*--notes-file "\$release_notes_path"[\s\S]*--generate-notes[\s\S]*--notes-start-tag/u,
  );
  assert.match(prepare, /gh release view[\s\S]*--json body[\s\S]*> "\$release_body_path"/u);
  assert.ok(
    prepare.indexOf("node scripts/desktop-release-notes.mjs") >= 0 &&
      prepare.indexOf("gh release edit") >
        prepare.indexOf("node scripts/desktop-release-notes.mjs"),
  );
  assert.match(
    prepare,
    /printf '%s\\n' "\$release_notes"[\s\S]*cat "\$release_body_path"[\s\S]*--notes-file "\$combined_notes_path"/u,
  );
  assert.match(publish, /gh release view[\s\S]*--json body[\s\S]*> "\$release_body_path"/u);
  assert.ok(
    publish.indexOf("node scripts/desktop-release-notes.mjs") >= 0 &&
      publish.indexOf("--draft=false") > publish.indexOf("node scripts/desktop-release-notes.mjs"),
  );
  for (const value of [prepare, publish]) {
    assert.doesNotMatch(value, /printf [^\n]*\|[ ]*grep -q|HMM Chat/u);
    assert.match(value, /--title "Hype Comms \$\{DESKTOP_VERSION\}"/u);
  }
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
