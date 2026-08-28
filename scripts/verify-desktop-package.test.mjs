import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEVELOPMENT_DESKTOP_BUILD_FLAVOR,
  PRODUCTION_DESKTOP_BUILD_FLAVOR,
} from "../apps/desktop/build-flavor.mjs";
import {
  collectPackageFiles,
  excludedPackageDirectories,
  findLinuxDebPaths,
  readDesktopEntryFromDeb,
  resolveExpectedProductionApiOrigin,
  resolveExpectedAgentWakeBuild,
  resolveExpectedAgentWakePackageEvidence,
  verifyAgentWakeBuild,
  verifyAgentWakeUpdateIsolation,
  verifyProtocolHandlerDesktopEntry,
  verifyDesktopEntryMimeType,
  verifyPackageEntries,
  verifyPackageMetadata,
  verifyPackagedApiOrigin,
  verifyUpdateConfiguration,
} from "./verify-desktop-package.mjs";

const missingFile = async () => {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
};

const baselinePackageEntries = () =>
  new Set([
    "/dist/main/build-metadata.json",
    "/dist/main/index.js",
    "/dist/main/claude-acp-worker.js",
    "/dist/main/codex-app-server-worker.js",
    "/dist/preload/index.js",
    "/dist/renderer/index.html",
    "/dist/renderer/assets/index.js",
    "/node_modules/@agentclientprotocol/claude-agent-acp/package.json",
    "/node_modules/@agentclientprotocol/sdk/package.json",
    "/node_modules/electron-updater/package.json",
    "/node_modules/electron-updater/out/main.js",
  ]);

const agentWakeMain = (configurationEnabled, operatorEnabled = configurationEnabled) =>
  Buffer.from(`
var agentWakeConfigurationPath = resolveAgentWakeConfigurationPath({
  compiledIn: ${String(configurationEnabled)},
  env: process.env
});
var agentWakeOperatorRequestPath = resolveAgentWakeOperatorRequestPath({
  compiledIn: ${String(operatorEnabled)},
  env: process.env
});
`);

const guardedAgentWakeMain = (configurationEnabled, operatorEnabled = configurationEnabled) =>
  Buffer.from(`
async function initializeAgentWakeRuntime() {
  const filePath = resolveAgentWakeConfigurationPath({
    compiledIn: ${String(configurationEnabled)},
    env: process.env
  });
  const operatorRequestPath = resolveAgentWakeOperatorRequestPath({
    compiledIn: ${String(operatorEnabled)},
    env: process.env
  });
}
`);

const agentWakeUpdaterMain = (evidenceBuild) =>
  Buffer.from(`
updateController = new UpdateController({
  updater: createUpdateSource(),
  updatesAllowed: ${String(!evidenceBuild)},
  isProductionBuild: true
});
`);

const agentWakeUnfoldedUpdaterMain = (updatesAllowedExpression) =>
  Buffer.from(`
updateController = new UpdateController({
  updater: createUpdateSource(),
  updatesAllowed: ${updatesAllowedExpression},
  isProductionBuild: true
});
`);

const desktopBuildMetadata = (apiOrigin) => Buffer.from(JSON.stringify({ apiOrigin }, null, 2));

test("requires the Codex worker without allowing bundled Codex packages or executables", () => {
  const asarPath = "/tmp/hype-comms/resources/app.asar";
  assert.doesNotThrow(() => verifyPackageEntries(asarPath, baselinePackageEntries()));

  const missingWorker = baselinePackageEntries();
  missingWorker.delete("/dist/main/codex-app-server-worker.js");
  assert.throws(
    () => verifyPackageEntries(asarPath, missingWorker),
    /missing \/dist\/main\/codex-app-server-worker\.js/u,
  );

  const bundledPackage = baselinePackageEntries();
  bundledPackage.add("/node_modules/@openai/codex/package.json");
  assert.throws(
    () => verifyPackageEntries(asarPath, bundledPackage),
    /contains bundled official Codex packages/u,
  );

  for (const executable of ["/vendor/codex", "/vendor/codex.exe"]) {
    const bundledExecutable = baselinePackageEntries();
    bundledExecutable.add(executable);
    assert.throws(
      () => verifyPackageEntries(asarPath, bundledExecutable),
      /contains a bundled Codex executable/u,
    );
  }
});

test("binds production packages to the configured deployed API origin", () => {
  const asarPath = "/tmp/hype-comms/resources/app.asar";
  const deployedOrigin = "https://chat.example.com";
  assert.equal(resolveExpectedProductionApiOrigin(`${deployedOrigin}/`), deployedOrigin);
  for (const invalidOrigin of [
    undefined,
    "",
    "http://chat.example.com",
    "https://chat.example.com/v1",
    "https://chat-api.example.invalid",
    "https://chat-api.example.invalid.",
    "https://chat-api.example.invalid:8443",
  ]) {
    assert.throws(
      () => resolveExpectedProductionApiOrigin(invalidOrigin),
      /HYPE_COMMS_API_ORIGIN/u,
    );
  }

  assert.doesNotThrow(() =>
    verifyPackagedApiOrigin(asarPath, deployedOrigin, () => desktopBuildMetadata(deployedOrigin)),
  );
  assert.throws(
    () =>
      verifyPackagedApiOrigin(asarPath, deployedOrigin, () =>
        desktopBuildMetadata("https://chat-api.example.invalid"),
      ),
    /API origin must be https:\/\/chat\.example\.com/u,
  );
  assert.throws(
    () => verifyPackagedApiOrigin(asarPath, deployedOrigin, () => Buffer.from("not JSON")),
    /invalid desktop build metadata/u,
  );
  assert.throws(
    () =>
      verifyPackagedApiOrigin(asarPath, deployedOrigin, () =>
        Buffer.from(JSON.stringify({ apiOrigin: deployedOrigin, unexpected: true })),
      ),
    /invalid desktop build metadata/u,
  );
});

test("binds packaged Agent Wake code to the explicit build switch", () => {
  const asarPath = "/tmp/hype-comms/resources/app.asar";
  assert.equal(resolveExpectedAgentWakeBuild(undefined), false);
  assert.equal(resolveExpectedAgentWakeBuild(" 0 "), false);
  assert.equal(resolveExpectedAgentWakeBuild(" 1 "), true);
  assert.throws(
    () => resolveExpectedAgentWakeBuild("true"),
    /HYPE_COMMS_AGENT_WAKE_ENABLED must be 0 or 1/u,
  );

  assert.doesNotThrow(() => verifyAgentWakeBuild(asarPath, true, () => agentWakeMain(true)));
  assert.doesNotThrow(() => verifyAgentWakeBuild(asarPath, false, () => agentWakeMain(false)));
  assert.throws(
    () => verifyAgentWakeBuild(asarPath, true, () => agentWakeMain(false)),
    /Agent Wake build state does not match HYPE_COMMS_AGENT_WAKE_ENABLED=1/u,
  );
  assert.throws(
    () => verifyAgentWakeBuild(asarPath, true, () => agentWakeMain(true, false)),
    /Agent Wake build state does not match HYPE_COMMS_AGENT_WAKE_ENABLED=1/u,
  );
  assert.throws(
    () => verifyAgentWakeBuild(asarPath, false, () => Buffer.from("no wake marker")),
    /ambiguous or missing Agent Wake build marker/u,
  );
});

test("finds Agent Wake build markers after path resolution moves behind startup handling", () => {
  const asarPath = "/tmp/hype-comms/resources/app.asar";
  assert.doesNotThrow(() => verifyAgentWakeBuild(asarPath, true, () => guardedAgentWakeMain(true)));
  assert.doesNotThrow(() =>
    verifyAgentWakeBuild(asarPath, false, () => guardedAgentWakeMain(false)),
  );
});

test("binds packaged updater isolation to an explicit Agent Wake evidence build", () => {
  const asarPath = "/tmp/hype-comms/resources/app.asar";
  assert.equal(resolveExpectedAgentWakePackageEvidence(undefined, true), false);
  assert.equal(resolveExpectedAgentWakePackageEvidence(" 0 ", true), false);
  assert.equal(resolveExpectedAgentWakePackageEvidence(" 1 ", true), true);
  assert.throws(
    () => resolveExpectedAgentWakePackageEvidence("true", true),
    /HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED must be 0 or 1/u,
  );
  assert.throws(
    () => resolveExpectedAgentWakePackageEvidence("1", false),
    /requires HYPE_COMMS_AGENT_WAKE_ENABLED=1/u,
  );

  assert.doesNotThrow(() =>
    verifyAgentWakeUpdateIsolation(asarPath, true, () => agentWakeUpdaterMain(true)),
  );
  assert.doesNotThrow(() =>
    verifyAgentWakeUpdateIsolation(asarPath, false, () => agentWakeUpdaterMain(false)),
  );
  assert.throws(
    () => verifyAgentWakeUpdateIsolation(asarPath, true, () => agentWakeUpdaterMain(false)),
    /updater isolation does not match/u,
  );
  assert.throws(
    () => verifyAgentWakeUpdateIsolation(asarPath, false, () => Buffer.from("no marker")),
    /ambiguous or missing Agent Wake updater-isolation marker/u,
  );
});

test("recognizes semantically equivalent updater-isolation literals without optimizer folding", () => {
  const asarPath = "/tmp/hype-comms/resources/app.asar";
  for (const [expectedEvidenceBuild, expression] of [
    [false, "!false"],
    [false, "!0"],
    [true, "!true"],
    [true, "!1"],
  ]) {
    assert.doesNotThrow(() =>
      verifyAgentWakeUpdateIsolation(asarPath, expectedEvidenceBuild, () =>
        agentWakeUnfoldedUpdaterMain(expression),
      ),
    );
  }
});

test("requires development packages to omit updater configuration", async () => {
  await assert.doesNotReject(
    verifyUpdateConfiguration(
      "/tmp/hype-comms-dev/resources/app.asar",
      DEVELOPMENT_DESKTOP_BUILD_FLAVOR,
      missingFile,
    ),
  );
  await assert.rejects(
    verifyUpdateConfiguration(
      "/tmp/hype-comms-dev/resources/app.asar",
      DEVELOPMENT_DESKTOP_BUILD_FLAVOR,
      async () => "provider: generic\nurl: https://updates.hypemm.com/desktop\n",
    ),
    /development builds cannot contain a publish feed/u,
  );
});

test("requires production packages to use the stable update feed", async () => {
  await assert.doesNotReject(
    verifyUpdateConfiguration(
      "/tmp/hype-comms/resources/app.asar",
      PRODUCTION_DESKTOP_BUILD_FLAVOR,
      async () => "provider: generic\nurl: https://updates.hypemm.com/desktop\n",
    ),
  );
  await assert.rejects(
    verifyUpdateConfiguration(
      "/tmp/hype-comms/resources/app.asar",
      PRODUCTION_DESKTOP_BUILD_FLAVOR,
      async () => "provider: generic\nurl: https://updates.example/desktop\n",
    ),
    /update feed must be https:\/\/updates\.hypemm\.com\/desktop/u,
  );
});

test("requires publisherName in production update config when Windows signing is configured", async () => {
  const previousPublisher = process.env.HYPE_COMMS_WINDOWS_PUBLISHER_NAME;
  process.env.HYPE_COMMS_WINDOWS_PUBLISHER_NAME =
    "CN=Hype Comms, O=Hypothetical Money Machine, C=US";
  try {
    await assert.doesNotReject(
      verifyUpdateConfiguration(
        "/tmp/hype-comms/resources/app.asar",
        PRODUCTION_DESKTOP_BUILD_FLAVOR,
        async () =>
          "provider: generic\nurl: https://updates.hypemm.com/desktop\npublisherName: CN=Hype Comms, O=Hypothetical Money Machine, C=US\n",
      ),
    );
    await assert.rejects(
      verifyUpdateConfiguration(
        "/tmp/hype-comms/resources/app.asar",
        PRODUCTION_DESKTOP_BUILD_FLAVOR,
        async () => "provider: generic\nurl: https://updates.hypemm.com/desktop\n",
      ),
      /must contain exactly one publisherName/u,
    );
  } finally {
    if (previousPublisher === undefined) {
      delete process.env.HYPE_COMMS_WINDOWS_PUBLISHER_NAME;
    } else {
      process.env.HYPE_COMMS_WINDOWS_PUBLISHER_NAME = previousPublisher;
    }
  }
});

const protocolIdentityMain = (desktopName) =>
  Buffer.from(
    [
      "configureApplicationIdentity(electron.app, process.platform, {",
      `  appId: "${PRODUCTION_DESKTOP_BUILD_FLAVOR.appId}",`,
      `  desktopName: "${desktopName}",`,
      "  isProductionBuild: true",
      "});",
    ].join("\n"),
  );

const desktopEntrySource = (mimeType) =>
  Buffer.from(["[Desktop Entry]", "Type=Application", `MimeType=${mimeType};`, ""].join("\n"));

test("requires the packaged Linux desktop entry to name the application identity", () => {
  const productionEntry = desktopEntrySource(
    `x-scheme-handler/${PRODUCTION_DESKTOP_BUILD_FLAVOR.protocolScheme}`,
  );
  const developmentEntry = desktopEntrySource(
    `x-scheme-handler/${DEVELOPMENT_DESKTOP_BUILD_FLAVOR.protocolScheme}`,
  );

  assert.doesNotThrow(() =>
    verifyProtocolHandlerDesktopEntry(
      protocolIdentityMain(PRODUCTION_DESKTOP_BUILD_FLAVOR.desktopName),
      productionEntry,
      PRODUCTION_DESKTOP_BUILD_FLAVOR,
    ),
  );
  assert.doesNotThrow(() =>
    verifyProtocolHandlerDesktopEntry(
      protocolIdentityMain(DEVELOPMENT_DESKTOP_BUILD_FLAVOR.desktopName),
      developmentEntry,
      DEVELOPMENT_DESKTOP_BUILD_FLAVOR,
    ),
  );
  assert.throws(
    () =>
      verifyProtocolHandlerDesktopEntry(
        Buffer.from("no identity").toString("utf8"),
        productionEntry,
        PRODUCTION_DESKTOP_BUILD_FLAVOR,
      ),
    /desktop main has no application identity/u,
  );
  assert.throws(
    () =>
      verifyProtocolHandlerDesktopEntry(
        protocolIdentityMain(DEVELOPMENT_DESKTOP_BUILD_FLAVOR.desktopName),
        productionEntry,
        PRODUCTION_DESKTOP_BUILD_FLAVOR,
      ),
    /application identity must be com\.hypemm\.hypecomms\.desktop/u,
  );
});

test("requires the packaged Linux desktop entry to declare the scheme", () => {
  const { protocolScheme } = PRODUCTION_DESKTOP_BUILD_FLAVOR;
  const noMimeTypeLineEntry = Buffer.from(["[Desktop Entry]", "Type=Application", ""].join("\n"));
  const emptyMimeTypeEntry = desktopEntrySource("");
  const wrongSchemeEntry = desktopEntrySource(
    `x-scheme-handler/${DEVELOPMENT_DESKTOP_BUILD_FLAVOR.protocolScheme}`,
  );

  assert.doesNotThrow(() =>
    verifyDesktopEntryMimeType(
      desktopEntrySource(`x-scheme-handler/${protocolScheme}`),
      PRODUCTION_DESKTOP_BUILD_FLAVOR,
    ),
  );
  assert.doesNotThrow(() =>
    verifyDesktopEntryMimeType(
      desktopEntrySource(`x-scheme-handler/${DEVELOPMENT_DESKTOP_BUILD_FLAVOR.protocolScheme}`),
      DEVELOPMENT_DESKTOP_BUILD_FLAVOR,
    ),
  );
  // electron-builder appends the scheme handler after configured mime types, so it must be
  // accepted anywhere in the list.
  assert.doesNotThrow(() =>
    verifyDesktopEntryMimeType(
      desktopEntrySource(`application/x-hype-comms;x-scheme-handler/${protocolScheme}`),
      PRODUCTION_DESKTOP_BUILD_FLAVOR,
    ),
  );
  assert.throws(
    () => verifyDesktopEntryMimeType(noMimeTypeLineEntry, PRODUCTION_DESKTOP_BUILD_FLAVOR),
    /must declare MimeType=x-scheme-handler\/hype-comms;/u,
  );
  assert.throws(
    () => verifyDesktopEntryMimeType(emptyMimeTypeEntry, PRODUCTION_DESKTOP_BUILD_FLAVOR),
    /must include x-scheme-handler\/hype-comms; found none/u,
  );
  assert.throws(
    () => verifyDesktopEntryMimeType(wrongSchemeEntry, PRODUCTION_DESKTOP_BUILD_FLAVOR),
    /found x-scheme-handler\/hype-comms-dev/u,
  );
  assert.throws(
    () =>
      verifyDesktopEntryMimeType(
        desktopEntrySource("application/x-foo;application/x-bar"),
        PRODUCTION_DESKTOP_BUILD_FLAVOR,
      ),
    /must include x-scheme-handler\/hype-comms; found application\/x-foo, application\/x-bar/u,
  );
});

const createDebFixture = async (directory, files) => {
  const stage = path.join(directory, "stage");
  await mkdir(path.join(stage, "usr", "share", "applications"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(stage, "usr", "share", "applications", name), contents);
  }
  const runOrFail = (command, args) => {
    const result = spawnSync(command, args, { cwd: directory });
    assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  };
  runOrFail("tar", ["-czf", "data.tar.gz", "-C", "stage", "."]);
  await writeFile(path.join(directory, "debian-binary"), "2.0\n");
  runOrFail("tar", ["-czf", "control.tar.gz", "-T", "/dev/null"]);
  const debPath = path.join(directory, "fixture.deb");
  // -S keeps macOS ar from injecting a ranlib symbol table that hides the member names.
  runOrFail("ar", ["rcS", "fixture.deb", "debian-binary", "control.tar.gz", "data.tar.gz"]);
  return debPath;
};

test("reads the desktop entry out of a packaged deb", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-deb-"));
  try {
    const { desktopName, protocolScheme } = PRODUCTION_DESKTOP_BUILD_FLAVOR;
    const entryContents = desktopEntrySource(`x-scheme-handler/${protocolScheme}`);
    const debPath = await createDebFixture(directory, { [desktopName]: entryContents });

    const extracted = readDesktopEntryFromDeb(debPath, desktopName);
    assert.deepEqual(extracted, entryContents);
    assert.doesNotThrow(() =>
      verifyDesktopEntryMimeType(extracted, PRODUCTION_DESKTOP_BUILD_FLAVOR),
    );

    assert.throws(
      () => readDesktopEntryFromDeb(debPath, DEVELOPMENT_DESKTOP_BUILD_FLAVOR.desktopName),
      /does not package usr\/share\/applications\/hype-comms-dev\.desktop/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires a packaged deb before verifying the Linux desktop entry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-release-"));
  try {
    await assert.rejects(findLinuxDebPaths(directory), /No packaged \.deb found under/u);

    await writeFile(path.join(directory, "hype-comms-0.1.27-linux-x86_64.deb"), "stub");
    await writeFile(path.join(directory, "hype-comms-0.1.27-linux-arm64.deb"), "stub");
    await mkdir(path.join(directory, "dev"));
    await writeFile(path.join(directory, "dev", "hype-comms-dev-0.1.27-linux-arm64.deb"), "stub");

    assert.deepEqual(await findLinuxDebPaths(directory), [
      path.join(directory, "hype-comms-0.1.27-linux-arm64.deb"),
      path.join(directory, "hype-comms-0.1.27-linux-x86_64.deb"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires packaged metadata to carry the selected native identity", () => {
  const extractDevelopmentPackage = () =>
    Buffer.from(
      JSON.stringify({
        name: "hype-comms-dev",
        productName: "Hype Comms DEV",
        desktopName: "hype-comms-dev.desktop",
      }),
    );
  assert.doesNotThrow(() =>
    verifyPackageMetadata(
      "/tmp/hype-comms-dev/resources/app.asar",
      DEVELOPMENT_DESKTOP_BUILD_FLAVOR,
      extractDevelopmentPackage,
    ),
  );
  assert.throws(
    () =>
      verifyPackageMetadata(
        "/tmp/hype-comms-dev/resources/app.asar",
        DEVELOPMENT_DESKTOP_BUILD_FLAVOR,
        () =>
          Buffer.from(
            JSON.stringify({
              name: "@hype-comms/desktop",
              productName: "Hype Comms",
              desktopName: "com.hypemm.hypecomms.desktop",
            }),
          ),
      ),
    /package metadata name must be hype-comms-dev/u,
  );
});

test("preserves the released production package metadata used for the profile path", () => {
  const productionMetadata = {
    name: "@hype-comms/desktop",
    desktopName: "com.hypemm.hypecomms.desktop",
  };
  assert.doesNotThrow(() =>
    verifyPackageMetadata(
      "/tmp/hype-comms/resources/app.asar",
      PRODUCTION_DESKTOP_BUILD_FLAVOR,
      () => Buffer.from(JSON.stringify(productionMetadata)),
    ),
  );
  assert.throws(
    () =>
      verifyPackageMetadata(
        "/tmp/hype-comms/resources/app.asar",
        PRODUCTION_DESKTOP_BUILD_FLAVOR,
        () => Buffer.from(JSON.stringify({ ...productionMetadata, productName: "Hype Comms" })),
      ),
    /production package metadata must not override productName/u,
  );
});

test("production package collection excludes stale nested development output", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "hype-comms-release-"));
  try {
    const productionAsar = path.join(releaseRoot, "linux-unpacked", "resources", "app.asar");
    const developmentAsar = path.join(
      releaseRoot,
      "dev",
      "linux-unpacked",
      "resources",
      "app.asar",
    );
    await Promise.all([
      mkdir(path.dirname(productionAsar), { recursive: true }),
      mkdir(path.dirname(developmentAsar), { recursive: true }),
    ]);
    await Promise.all([writeFile(productionAsar, "production"), writeFile(developmentAsar, "dev")]);

    assert.deepEqual(excludedPackageDirectories(PRODUCTION_DESKTOP_BUILD_FLAVOR, releaseRoot), [
      path.join(releaseRoot, "dev"),
    ]);
    assert.deepEqual(excludedPackageDirectories(DEVELOPMENT_DESKTOP_BUILD_FLAVOR, releaseRoot), []);
    assert.deepEqual(
      await collectPackageFiles(
        releaseRoot,
        "app.asar",
        excludedPackageDirectories(PRODUCTION_DESKTOP_BUILD_FLAVOR, releaseRoot),
      ),
      [productionAsar],
    );
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});
