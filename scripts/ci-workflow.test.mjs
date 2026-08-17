import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowJob = (workflow, jobName) => {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Expected workflow job ${jobName}`);

  const remainingWorkflow = workflow.slice(start + marker.length);
  const nextJob = remainingWorkflow.search(/^ {2}[a-zA-Z0-9_-]+:\n/mu);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + nextJob);
};

test("isolates a workflow job from neighboring jobs", () => {
  const workflow = `jobs:
  check:
    runs-on: [self-hosted, Linux, ARM64]
  package:
    runs-on: [self-hosted, Linux, X64]
    run: sudo apt-get install package
`;

  assert.equal(
    workflowJob(workflow, "check"),
    `  check:
    runs-on: [self-hosted, Linux, ARM64]
`,
  );
});

test("runs PostgreSQL CI on the shared x64 runner group", async () => {
  const ciWorkflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const runnerDockerfile = await readFile(
    new URL("../.github/runner/Dockerfile", import.meta.url),
    "utf8",
  );
  const postgresJob = workflowJob(ciWorkflow, "check");

  assert.match(postgresJob, /runs-on:\n {6}group: hmm-linux-x64-ci\n {6}labels: hmm-ci/u);
  assert.doesNotMatch(postgresJob, /ARM64|hype-comms-release|docker/u);
  assert.match(runnerDockerfile, /^ {4}postgresql-16 \\$/mu);
  assert.match(postgresJob, /Verify PostgreSQL 16 runner image/u);
  assert.match(postgresJob, /npm run test:postgres -- --testTimeout 10000/u);
  assert.doesNotMatch(postgresJob, /sudo|apt-get install/u);
});
