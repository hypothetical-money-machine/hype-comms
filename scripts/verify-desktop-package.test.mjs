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
  verifyPackageMetadata,
  verifyUpdateConfiguration,
} from "./verify-desktop-package.mjs";

const missingFile = async () => {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
};

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

test("requires packaged metadata to carry the selected native identity", () => {
  const extractDevelopmentPackage = () =>
    Buffer.from(
      JSON.stringify({
        name: "hype-comms-dev",
        productName: "Hype Comms DEV",
        desktopName: "hype-comms-dev",
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
