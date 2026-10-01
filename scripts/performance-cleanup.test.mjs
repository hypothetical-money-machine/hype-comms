import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finishPerformanceRuntime, removePerformanceRuntimeData } from "./performance-cleanup.mjs";

async function runtimeFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-performance-finish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["postgres", "profiles", "callbacks"]) {
    await mkdir(path.join(directory, name));
    await writeFile(path.join(directory, name, "data"), "synthetic");
  }
  return directory;
}

async function assertRuntimeRetained(directory) {
  for (const name of ["postgres", "profiles", "callbacks"]) {
    assert.equal(await readFile(path.join(directory, name, "data"), "utf8"), "synthetic");
  }
}

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

test("saves structured failure results and retains every runtime directory when process stop fails", async (t) => {
  const directory = await runtimeFixture(t);
  const shutdownError = new Error("Electron process failed to stop");
  await assert.rejects(
    finishPerformanceRuntime(
      {
        stop: () => {
          throw shutdownError;
        },
        directory,
        result: { status: "complete", metrics: { sample: 42 } },
      },
      null,
    ),
    (error) => error === shutdownError,
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "results.json"), "utf8")), {
    status: "failed",
    metrics: { sample: 42 },
    error: shutdownError.message,
    cleanupError: shutdownError.message,
  });
  await assertRuntimeRetained(directory);
});

test("stops before persisting results and removes runtime data only after both succeed", async (t) => {
  const directory = await runtimeFixture(t);
  let stopped = false;
  await finishPerformanceRuntime(
    {
      stop: async () => {
        await assertRuntimeRetained(directory);
        await assert.rejects(readFile(path.join(directory, "results.json")), { code: "ENOENT" });
        stopped = true;
      },
      directory,
      result: { status: "complete" },
    },
    null,
  );
  assert.equal(stopped, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "results.json"), "utf8")), {
    status: "complete",
  });
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(directory, "results.json"))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(directory), ["results.json"]);
});

test("keeps requested runtime data after a successful shutdown and result save", async (t) => {
  const directory = await runtimeFixture(t);
  await finishPerformanceRuntime(
    {
      stop: () => {},
      directory,
      result: { status: "complete" },
      keepRuntimeData: true,
    },
    null,
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "results.json"), "utf8")), {
    status: "complete",
  });
  await assertRuntimeRetained(directory);
});

test("retains runtime data and reports a result-write failure after a successful scenario", async (t) => {
  const directory = await runtimeFixture(t);
  await mkdir(path.join(directory, "results.json"));
  await assert.rejects(
    finishPerformanceRuntime({ stop: () => {}, directory, result: { status: "complete" } }, null),
    { path: path.join(directory, "results.json"), syscall: "open" },
  );
  await assertRuntimeRetained(directory);
});

test("preserves the scenario error and runtime data if saving results also fails", async (t) => {
  const directory = await runtimeFixture(t);
  await mkdir(path.join(directory, "results.json"));
  const scenarioError = new Error("benchmark scenario failed");
  const report = t.mock.method(console, "error", () => {});
  await assert.rejects(
    async () => {
      try {
        throw scenarioError;
      } finally {
        await finishPerformanceRuntime(
          {
            stop: () => {},
            directory,
            result: { status: "failed", error: scenarioError.message },
          },
          scenarioError,
        );
      }
    },
    (error) => error === scenarioError,
  );
  assert.equal(report.mock.calls[0].arguments[1].path, path.join(directory, "results.json"));
  await assertRuntimeRetained(directory);
});

test("reports a result-write failure without replacing the earlier shutdown failure", async (t) => {
  const directory = await runtimeFixture(t);
  await mkdir(path.join(directory, "results.json"));
  const shutdownError = new Error("PostgreSQL shutdown timeout");
  const report = t.mock.method(console, "error", () => {});
  await assert.rejects(
    finishPerformanceRuntime(
      {
        stop: () => {
          throw shutdownError;
        },
        directory,
        result: { status: "complete" },
      },
      null,
    ),
    (error) => error === shutdownError,
  );
  assert.equal(report.mock.calls[0].arguments[1].path, path.join(directory, "results.json"));
  await assertRuntimeRetained(directory);
});

for (const scenarioError of [null, new Error("benchmark scenario failed")]) {
  test(
    scenarioError === null
      ? "rewrites saved success results as failed and reports a runtime-removal error"
      : "records a runtime-removal error in saved results while preserving the scenario error",
    async (t) => {
      const directory = await runtimeFixture(t);
      const removalError = new Error("runtime removal failed");
      const report = t.mock.method(console, "error", () => {});
      const result =
        scenarioError === null
          ? { status: "complete", metrics: { sample: 42 } }
          : { status: "failed", error: scenarioError.message, metrics: { sample: 42 } };
      const beforeRemoval = structuredClone(result);
      let stopped = false;
      let removalAttempted = false;
      await assert.rejects(
        async () => {
          try {
            if (scenarioError !== null) throw scenarioError;
          } finally {
            await finishPerformanceRuntime(
              {
                stop: () => {
                  stopped = true;
                },
                directory,
                result,
                removeRuntimeData: async (runtimeDirectory) => {
                  removalAttempted = true;
                  assert.equal(runtimeDirectory, directory);
                  assert.equal(stopped, true);
                  await assertRuntimeRetained(directory);
                  assert.deepEqual(
                    JSON.parse(await readFile(path.join(directory, "results.json"), "utf8")),
                    beforeRemoval,
                  );
                  assert.equal(result.cleanupError, undefined);
                  throw removalError;
                },
              },
              scenarioError,
            );
          }
        },
        (error) => error === (scenarioError ?? removalError),
      );
      assert.equal(removalAttempted, true);
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, "results.json"), "utf8")), {
        status: "failed",
        metrics: { sample: 42 },
        error: (scenarioError ?? removalError).message,
        cleanupError: removalError.message,
      });
      await assertRuntimeRetained(directory);
      if (scenarioError !== null) {
        assert.equal(report.mock.calls[0].arguments[1], removalError);
      }
    },
  );
}
