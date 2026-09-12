import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the candidate manifest describes uploaded packages and feeds, excluding builder diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-manifest-test-"));
  try {
    const release = path.join(directory, "apps/desktop/release");
    await mkdir(release, { recursive: true });
    await writeFile(path.join(directory, "apps/desktop/package.json"), '{"version":"0.2.0"}');
    for (const name of [
      "hype-comms-0.2.0-linux-arm64.AppImage",
      "latest-linux-arm64.yml",
      "builder-debug.yml",
    ]) {
      await writeFile(path.join(release, name), name);
    }
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./rehearsal-package-manifest.mjs", import.meta.url))],
      {
        cwd: directory,
        env: { ...process.env, GITHUB_SHA: "a".repeat(40) },
        stdio: "pipe",
      },
    );
    const manifest = JSON.parse(
      await readFile(path.join(directory, ".dev-data/rehearsal/package-manifest.json"), "utf8"),
    );
    assert.deepEqual(
      manifest.artifacts.map((artifact) => artifact.name),
      ["hype-comms-0.2.0-linux-arm64.AppImage", "latest-linux-arm64.yml"],
    );
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(path.join(release, artifact.name));
      assert.equal(artifact.size, bytes.length);
      assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
