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

test("runs public PostgreSQL CI on disposable GitHub-hosted infrastructure", async () => {
  const ciWorkflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const postgresJob = workflowJob(ciWorkflow, "check");

  assert.match(ciWorkflow, /^ {2}merge_group:\n {4}types: \[checks_requested\]$/mu);
  assert.match(ciWorkflow, /^permissions:\n {2}contents: read$/mu);
  assert.match(postgresJob, /^ {4}runs-on: ubuntu-24\.04$/mu);
  assert.match(postgresJob, /^ {4}services:\n {6}postgres:\n {8}image: postgres:16$/mu);
  assert.match(postgresJob, /^ {10}POSTGRES_DB: hype_comms_test$/mu);
  assert.match(postgresJob, /^ {10}POSTGRES_USER: hype_comms$/mu);
  assert.match(postgresJob, /^ {10}- 55432:5432$/mu);
  assert.match(postgresJob, /HYPE_COMMS_TEST_DATABASE_URL: postgresql:\/\//u);
  assert.match(postgresJob, /npm ci --no-audit --prefer-offline/u);
  // Cache dependency downloads only; node_modules is rebuilt from the verified lockfile each run.
  assert.match(
    postgresJob,
    /uses: actions\/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0/u,
  );
  assert.match(
    postgresJob,
    /key: ci-downloads-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/u,
  );
  assert.match(postgresJob, /^ {10}path: \|\n {12}~\/\.npm\n {12}~\/\.cache\/electron$/mu);
  assert.match(postgresJob, /npm run test:postgres -- --maxWorkers 4 --testTimeout 10000/u);
  assert.doesNotMatch(
    postgresJob,
    /self-hosted|hmm-ci|hype-comms-release|head\.repo\.full_name|initdb|pg_ctl|secrets\.|^ {4}environment:/mu,
  );
});
