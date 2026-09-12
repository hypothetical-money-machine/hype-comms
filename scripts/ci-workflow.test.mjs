import assert from "node:assert/strict";
import test from "node:test";

import {
  commands,
  readWorkflow,
  stepBefore,
  workflowJob,
  workflowStep,
} from "./workflow-test-support.mjs";

const cacheAction = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";

test("runs public PostgreSQL CI on disposable GitHub-hosted infrastructure", async () => {
  const workflow = await readWorkflow("ci.yml");
  const job = workflowJob(workflow, "check");
  assert.deepEqual(workflow.on.merge_group.types, ["checks_requested"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job.services.postgres.image, "postgres:16");
  assert.equal(job.services.postgres.env.POSTGRES_DB, "hype_comms_test");
  assert.equal(job.services.postgres.env.POSTGRES_USER, "hype_comms");
  assert.deepEqual(job.services.postgres.ports, ["55432:5432"]);
  const cache = workflowStep(job, "Restore dependency downloads");
  assert.equal(cache.uses, cacheAction);
  assert.deepEqual(cache.with.path.trim().split("\n"), ["~/.npm", "~/.cache/electron"]);
  assert.equal(
    cache.with.key,
    "ci-downloads-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}",
  );
  assert.equal(
    cache.with["restore-keys"].trim(),
    "ci-downloads-${{ runner.os }}-${{ runner.arch }}-",
  );
  assert.equal(workflowStep(job, "Install dependencies").run, "npm ci --no-audit --prefer-offline");
  stepBefore(job, "Restore dependency downloads", "Install dependencies");
  const check = workflowStep(
    job,
    "Check formatting, types, unit and integration tests, and production builds",
  );
  assert.equal(check.run, "npm run check");
  assert.match(check.env.HYPE_COMMS_TEST_DATABASE_URL, /^postgresql:\/\//u);
  assert.equal(job.environment, undefined);
  assert.doesNotMatch(
    JSON.stringify(job),
    /self-hosted|hmm-ci|hype-comms-release|head\.repo\.full_name|secrets\./u,
  );
  assert.doesNotMatch(commands(job), /initdb|pg_ctl/u);
});

test("runs headless demo smokes on disposable Ubuntu x64 and keeps diagnostics", async () => {
  const job = workflowJob(await readWorkflow("ci.yml"), "headless-linux-smoke");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 30);
  assert.equal(
    workflowStep(job, "Check out source").uses,
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  );
  const node = workflowStep(job, "Set up Node.js");
  assert.equal(node.uses, "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
  assert.deepEqual(node.with, {
    "node-version-file": ".node-version",
    "package-manager-cache": false,
  });
  assert.equal(
    workflowStep(job, "Run display-server-free demo smokes").run,
    "npm run test:demo:headless:linux",
  );
  const upload = workflowStep(job, "Upload headless Linux smoke diagnostics");
  assert.equal(upload.if, "always()");
  assert.equal(upload.uses, "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
  assert.deepEqual(upload.with, {
    name: "headless-linux-smoke-${{ github.run_id }}-${{ github.run_attempt }}",
    path: ".dev-data/demo/docker-headless/",
    "include-hidden-files": true,
    "if-no-files-found": "warn",
    "retention-days": 7,
  });
  assert.equal(job.environment, undefined);
  assert.doesNotMatch(JSON.stringify(job), /self-hosted|secrets\./u);
});
