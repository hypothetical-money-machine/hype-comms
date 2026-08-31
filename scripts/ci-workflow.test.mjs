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
  assert.match(
    postgresJob,
    /^ {10}restore-keys: \|\n {12}ci-downloads-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-$/mu,
  );
  // Downloads must be restored before npm ci runs, or the cache never serves the install.
  assert.match(
    postgresJob,
    /name: Restore dependency downloads[\s\S]*npm ci --no-audit --prefer-offline/u,
  );
  assert.match(postgresJob, /npm run test:postgres -- --maxWorkers 4 --testTimeout 10000/u);
  assert.doesNotMatch(
    postgresJob,
    /self-hosted|hmm-ci|hype-comms-release|head\.repo\.full_name|initdb|pg_ctl|secrets\.|^ {4}environment:/mu,
  );
});

test("runs the display-server-free demo smokes on Ubuntu x64", async () => {
  const ciWorkflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const headlessSmokeJob = workflowJob(ciWorkflow, "headless-linux-smoke");

  assert.match(headlessSmokeJob, /^ {4}name: Headless Linux smoke \(Ubuntu x64\)$/mu);
  assert.match(headlessSmokeJob, /^ {4}runs-on: ubuntu-24\.04$/mu);
  assert.match(headlessSmokeJob, /^ {4}timeout-minutes: 30$/mu);
  assert.match(
    headlessSmokeJob,
    /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7/u,
  );
  assert.match(
    headlessSmokeJob,
    /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7/u,
  );
  assert.match(headlessSmokeJob, /^ {10}node-version-file: \.node-version$/mu);
  assert.match(headlessSmokeJob, /^ {10}package-manager-cache: false$/mu);
  assert.match(headlessSmokeJob, /^ {8}run: npm run test:demo:headless:linux$/mu);
  assert.match(
    headlessSmokeJob,
    /^ {8}if: always\(\)\n {8}uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4$/mu,
  );
  assert.match(
    headlessSmokeJob,
    /^ {10}name: headless-linux-smoke-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/mu,
  );
  assert.match(headlessSmokeJob, /^ {10}path: \.dev-data\/demo\/docker-headless\/$/mu);
  assert.match(headlessSmokeJob, /^ {10}include-hidden-files: true$/mu);
  assert.match(headlessSmokeJob, /^ {10}if-no-files-found: warn$/mu);
  assert.match(headlessSmokeJob, /^ {10}retention-days: 7$/mu);
  assert.doesNotMatch(headlessSmokeJob, /self-hosted|secrets\.|^ {4}environment:/mu);
});
