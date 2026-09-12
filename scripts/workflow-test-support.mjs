import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export async function readWorkflow(name) {
  return parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
}

export function workflowJob(workflow, name) {
  const job = workflow.jobs?.[name];
  assert.ok(job !== undefined, `Expected workflow job ${name}`);
  return job;
}

export function workflowStep(job, name) {
  const matches = job.steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1, `Expected one workflow step ${name}`);
  return matches[0];
}

export function stepBefore(job, first, second) {
  const before = workflowStep(job, first);
  const after = workflowStep(job, second);
  assert.ok(
    job.steps.indexOf(before) < job.steps.indexOf(after),
    `${first} must precede ${second}`,
  );
}

export function commands(job) {
  return job.steps.map((step) => step.run ?? "").join("\n");
}
