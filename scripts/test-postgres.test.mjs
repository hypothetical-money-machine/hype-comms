import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

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
  const githubWorkflow = parse(github);
  const pipeline = parse(woodpecker);
  assert.deepEqual(githubWorkflow.permissions, { contents: "read" });
  assert.ok(githubWorkflow.jobs.check.steps.some((step) => step.run === "npm run check"));
  assert.equal(
    pipeline.services.find((service) => service.name === "postgres").image,
    "postgres:16-alpine",
  );
  assert.equal(pipeline.concurrency, undefined);
  const check = pipeline.steps.find((step) => step.name === "check");
  assert.ok(
    check.commands.some((command) =>
      /^HYPE_COMMS_TEST_DATABASE_URL=.*npm run check$/u.test(command),
    ),
  );
  const buildPush = pipeline.steps.find((step) => step.name === "build-push");
  assert.deepEqual(buildPush.depends_on, ["check"]);
  assert.equal(buildPush.environment.REGISTRY, "registry.fastnfree.dev");
  assert.equal(buildPush.environment.PROJECT, "homelab");
  assert.equal(buildPush.environment.APP, "hype-comms");
  assert.match(
    buildPush.image,
    /^gcr\.io\/kaniko-project\/executor:v1\.23\.2-debug@sha256:[a-f0-9]{64}$/u,
  );
  const publish = buildPush.commands.join("\n");
  for (const argument of [
    "--destination=$${REGISTRY}/$${PROJECT}/$${APP}:$${CI_COMMIT_SHA}",
    "--custom-platform=linux/amd64",
    "--label=org.opencontainers.image.revision=$${CI_COMMIT_SHA}",
    "--label=org.opencontainers.image.source=https://github.com/hypothetical-money-machine/hype-comms",
    "--image-name-tag-with-digest-file=/tmp/image-reference",
    "--reproducible",
  ])
    assert.ok(publish.includes(argument), argument);
  assert.ok(buildPush.commands.includes("cat /tmp/image-reference"));
  assert.doesNotMatch(
    JSON.stringify(pipeline),
    /:latest|promote-gitops|github_token|GITHUB_TOKEN|git push/u,
  );
  assert.deepEqual(buildPush.when, [
    { event: "push", branch: "main" },
    { event: "manual", branch: "main" },
  ]);
  assert.match(dockerfile, /FROM node:24\.18\.0-alpine@sha256:[a-f0-9]{64} AS base/);
});
