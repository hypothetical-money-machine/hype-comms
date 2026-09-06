import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removePerformanceRuntimeData } from "./performance-cleanup.mjs";

test("removes only disposable runtime directories and leaves evidence and other runs intact", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "hype-performance-cleanup-"));
  try {
    const run = path.join(parent, "run");
    for (const name of ["postgres", "profiles", "callbacks"]) {
      await mkdir(path.join(run, name, "nested"), { recursive: true });
      await writeFile(path.join(run, name, "nested", "data"), "synthetic");
    }
    for (const name of ["results.json", "postgres.log", "workspace.png", "composer.cpuprofile"]) {
      await writeFile(path.join(run, name), "evidence");
    }
    await mkdir(path.join(parent, "other-run"));
    await removePerformanceRuntimeData(run);
    await removePerformanceRuntimeData(run);
    assert.deepEqual((await readdir(run)).sort(), [
      "composer.cpuprofile",
      "postgres.log",
      "results.json",
      "workspace.png",
    ]);
    assert.deepEqual((await readdir(parent)).sort(), ["other-run", "run"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
