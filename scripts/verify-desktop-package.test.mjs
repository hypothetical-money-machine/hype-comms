import assert from "node:assert/strict";
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
  resolveExpectedAgentWakeBuild,
  resolveExpectedAgentWakePackageEvidence,
  verifyAgentWakeBuild,
  verifyAgentWakeUpdateIsolation,
  verifyPackageEntries,
  verifyPackageMetadata,
  verifyUpdateConfiguration,
} from "./verify-desktop-package.mjs";

const missingFile = async () => {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
};

const baselinePackageEntries = () =>
  new Set([
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
