import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finishPerformanceRuntime, removePerformanceRuntimeData } from "./performance-cleanup.mjs";
import { createPerformancePostgres } from "./performance-postgres.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-performance-postgres-"));
  await mkdir(path.join(directory, "postgres"));
  await writeFile(path.join(directory, "postgres", "data"), "synthetic database");
  await writeFile(path.join(directory, "postgres.log"), "startup evidence");
  return directory;
}

test("stops a timed-out PostgreSQL startup before deleting its runtime data", async () => {
  const directory = await fixture();
  const startupError = new Error("server did not start in time");
  const actions = [];
  let running = false;
  const postgres = createPerformancePostgres(
    (_command, args) => {
      const action = args.at(-1);
      actions.push(action);
      if (action === "start") {
        running = true;
        throw startupError;
      }
      assert.equal(action, "stop");
      running = false;
    },
    "/synthetic/postgres/bin",
    path.join(directory, "postgres"),
  );
  try {
    let scenarioError = null;
    await assert.rejects(
      async () => {
        try {
          postgres.start(path.join(directory, "postgres.log"), 5432);
        } catch (error) {
          scenarioError = error;
          throw error;
        } finally {
          await finishPerformanceRuntime(async () => {
            postgres.stop();
            assert.equal(running, false);
            actions.push("remove");
            await removePerformanceRuntimeData(directory);
          }, scenarioError);
        }
      },
      (error) => error === startupError,
    );
    assert.deepEqual(actions, ["start", "stop", "remove"]);
    await assert.rejects(readFile(path.join(directory, "postgres", "data")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(directory, "postgres.log"), "utf8"), "startup evidence");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves the startup error and runtime data when PostgreSQL shutdown fails", async (t) => {
  const directory = await fixture();
  const startupError = new Error("startup timeout");
  const shutdownError = new Error("shutdown timeout");
  const report = t.mock.method(console, "error", () => {});
  const actions = [];
  const postgres = createPerformancePostgres(
    (_command, args) => {
      actions.push(args.at(-1));
      throw args.at(-1) === "start" ? startupError : shutdownError;
    },
    "/synthetic/postgres/bin",
    path.join(directory, "postgres"),
  );
  try {
    let scenarioError = null;
    await assert.rejects(
      async () => {
        try {
          postgres.start(path.join(directory, "postgres.log"), 5432);
        } catch (error) {
          scenarioError = error;
          throw error;
        } finally {
          await finishPerformanceRuntime(async () => {
            postgres.stop();
            actions.push("remove");
            await removePerformanceRuntimeData(directory);
          }, scenarioError);
        }
      },
      (error) => error === startupError,
    );
    assert.deepEqual(actions, ["start", "stop"]);
    assert.equal(
      await readFile(path.join(directory, "postgres", "data"), "utf8"),
      "synthetic database",
    );
    assert.equal(report.mock.calls[0].arguments[1], shutdownError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports a shutdown failure after a successful scenario", async () => {
  const shutdownError = new Error("shutdown timeout");
  await assert.rejects(
    finishPerformanceRuntime(async () => {
      throw shutdownError;
    }, null),
    (error) => error === shutdownError,
  );
});

test("does not stop an unattempted or already stopped PostgreSQL process", () => {
  const actions = [];
  const postgres = createPerformancePostgres(
    (_command, args) => {
      actions.push(args.at(-1));
    },
    "/synthetic/postgres/bin",
    "/synthetic/postgres/data",
  );
  postgres.stop();
  postgres.start("/synthetic/postgres.log", 5432);
  postgres.stop();
  postgres.stop();
  assert.deepEqual(actions, ["start", "stop"]);
});
