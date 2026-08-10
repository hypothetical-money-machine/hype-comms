import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { requireTestDatabaseUrl, waitForPostgres } from "./test-postgres.mjs";

test("requires an explicitly test-named PostgreSQL database", () => {
  assert.throws(() => requireTestDatabaseUrl({}), /HMM_TEST_DATABASE_URL is required/);
  assert.throws(
    () =>
      requireTestDatabaseUrl({
        HMM_TEST_DATABASE_URL: "postgres://postgres.example/hmm_chat",
      }),
    /Refusing to run.*non-test database/i,
  );
  assert.throws(
    () =>
      requireTestDatabaseUrl({
        HMM_TEST_DATABASE_URL: "https://postgres.example/hmm_chat_test",
      }),
    /PostgreSQL URL/,
  );
  assert.equal(
    requireTestDatabaseUrl({
      HMM_TEST_DATABASE_URL: "postgresql://hmm:password@postgres:5432/hmm_chat_test",
    }),
    "postgresql://hmm:password@postgres:5432/hmm_chat_test",
  );
});

test("waits a bounded number of times for PostgreSQL", async () => {
  let attempts = 0;
  const sleeps = [];
  await waitForPostgres("postgres://postgres/hmm_chat_test", {
    attempts: 3,
    delayMs: 25,
    connect: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("not ready");
    },
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [25, 25]);

  attempts = 0;
  await assert.rejects(
    waitForPostgres("postgres://postgres/hmm_chat_test", {
      attempts: 2,
      delayMs: 0,
      connect: async () => {
        attempts += 1;
        throw new Error("still unavailable");
      },
      sleep: async () => undefined,
    }),
    /did not become ready after 2 attempts.*still unavailable/,
  );
  assert.equal(attempts, 2);
});

test("gates every promotion path through the guarded PostgreSQL entrypoint", async () => {
  const [packageJson, localDatabase, github, woodpecker] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("./test-database.sh", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../.woodpecker.yml", import.meta.url), "utf8"),
  ]);

  assert.equal(JSON.parse(packageJson).scripts["test:postgres"], "node scripts/test-postgres.mjs");
  assert.match(localDatabase, /npm run test:postgres/);
  assert.match(github, /run: npm run test:postgres/);
  assert.match(woodpecker, /image: postgres:16-alpine/);
  assert.match(woodpecker, /limit: 1/);
  assert.match(woodpecker, /HMM_TEST_DATABASE_URL=.*npm run test:postgres/);
  assert.match(woodpecker, /name: build-push[\s\S]*?depends_on:\n\s+- check/);
  assert.match(woodpecker, /name: promote-gitops[\s\S]*?depends_on:\n\s+- build-push/);

  const buildPushStart = woodpecker.indexOf("  - name: build-push");
  const promotionStart = woodpecker.indexOf("  - name: promote-gitops");
  assert.notEqual(buildPushStart, -1);
  assert.notEqual(promotionStart, -1);
  const buildPush = woodpecker.slice(buildPushStart, promotionStart);
  const promotion = woodpecker.slice(promotionStart);
  const mainOnly = /when:\n\s+- event: push\n\s+branch: main\n\s+- event: manual\n\s+branch: main/;
  assert.match(buildPush, mainOnly);
  assert.match(promotion, mainOnly);
});
