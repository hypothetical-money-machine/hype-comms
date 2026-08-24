import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { requireTestDatabaseUrl, waitForPostgres } from "./test-postgres.mjs";

test("requires an explicitly test-named PostgreSQL database", () => {
  assert.throws(() => requireTestDatabaseUrl({}), /HYPE_COMMS_TEST_DATABASE_URL is required/);
  assert.throws(
    () =>
      requireTestDatabaseUrl({
        HYPE_COMMS_TEST_DATABASE_URL: "postgres://postgres.example/hype_comms",
      }),
    /Refusing to run.*non-test database/i,
  );
  assert.throws(
    () =>
      requireTestDatabaseUrl({
        HYPE_COMMS_TEST_DATABASE_URL: "https://postgres.example/hype_comms_test",
      }),
    /PostgreSQL URL/,
  );
  assert.equal(
    requireTestDatabaseUrl({
      HYPE_COMMS_TEST_DATABASE_URL:
        "postgresql://hype_comms:password@postgres:5432/hype_comms_test",
    }),
    "postgresql://hype_comms:password@postgres:5432/hype_comms_test",
  );
});

test("waits a bounded number of times for PostgreSQL", async () => {
  let attempts = 0;
  const sleeps = [];
  await waitForPostgres("postgres://postgres/hype_comms_test", {
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
    waitForPostgres("postgres://postgres/hype_comms_test", {
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

test("gates every published server image through the guarded PostgreSQL entrypoint", async () => {
  const [packageJson, localDatabase, github, woodpecker, dockerfile] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("./test-database.sh", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../.woodpecker.yml", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  ]);

  assert.equal(JSON.parse(packageJson).scripts["test:postgres"], "node scripts/test-postgres.mjs");
  assert.match(localDatabase, /npm run test:postgres/);
  assert.match(github, /run: npm run test:postgres -- --maxWorkers 4 --testTimeout 10000/);
  assert.match(woodpecker, /image: postgres:16-alpine/);
  assert.doesNotMatch(woodpecker, /^concurrency:/mu);
  assert.match(woodpecker, /HYPE_COMMS_TEST_DATABASE_URL=.*npm run test:postgres/);
  assert.match(woodpecker, /name: build-push[\s\S]*?depends_on:\n\s+- check/);
  assert.match(woodpecker, /registry: &registry registry\.fastnfree\.dev/);
  assert.match(woodpecker, /project: &project homelab/);
  assert.match(
    woodpecker,
    /image: gcr\.io\/kaniko-project\/executor:v1\.23\.2-debug@sha256:[a-f0-9]{64}/,
  );
  assert.match(
    woodpecker,
    /--destination=\$\$\{REGISTRY\}\/\$\$\{PROJECT\}\/\$\$\{APP\}:\$\$\{CI_COMMIT_SHA\}/,
  );
  assert.match(woodpecker, /--custom-platform=linux\/amd64/);
  assert.match(woodpecker, /--label=org\.opencontainers\.image\.revision=\$\$\{CI_COMMIT_SHA\}/);
  assert.match(
    woodpecker,
    /--label=org\.opencontainers\.image\.source=https:\/\/github\.com\/hypothetical-money-machine\/hype-comms/,
  );
  assert.match(woodpecker, /--image-name-tag-with-digest-file=\/tmp\/image-reference/);
  assert.match(woodpecker, /--reproducible/);
  assert.match(woodpecker, /cat \/tmp\/image-reference/);
  assert.doesNotMatch(
    woodpecker,
    /:latest|name: promote-gitops|github_token|GITHUB_TOKEN|git push/,
  );
  assert.match(dockerfile, /FROM node:24\.18\.0-alpine@sha256:[a-f0-9]{64} AS base/);

  const buildPushStart = woodpecker.indexOf("  - name: build-push");
  assert.notEqual(buildPushStart, -1);
  const buildPush = woodpecker.slice(buildPushStart);
  const mainOnly = /when:\n\s+- event: push\n\s+branch: main\n\s+- event: manual\n\s+branch: main/;
  assert.match(buildPush, mainOnly);
});
