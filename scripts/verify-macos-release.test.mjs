import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectAppBundles, excludedMacosReleaseDirectories } from "./verify-macos-release.mjs";

test("production macOS verification excludes stale nested development apps", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "hype-comms-macos-release-"));
  try {
    const productionApp = path.join(releaseRoot, "mac", "Hype Comms.app");
    const developmentApp = path.join(releaseRoot, "dev", "mac", "Hype Comms DEV.app");
    await Promise.all([
      mkdir(productionApp, { recursive: true }),
      mkdir(developmentApp, { recursive: true }),
    ]);

    assert.deepEqual(excludedMacosReleaseDirectories(releaseRoot), [path.join(releaseRoot, "dev")]);
    assert.deepEqual(
      await collectAppBundles(releaseRoot, excludedMacosReleaseDirectories(releaseRoot)),
      [productionApp],
    );
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});
