import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AgentWakeEvidenceCollectorError,
  collectAgentWakeEvidenceObservation,
  initializeAgentWakeEvidenceRun,
  isSafeAgentWakeEvidenceAncestor,
  snapshotAgentWakeEvidenceRun,
} from "./collect-agent-wake-evidence.mjs";
import {
  AgentWakeEvidenceManifestError,
  parseAgentWakeEvidenceManifest,
} from "./validate-agent-wake-evidence-manifest.mjs";

const RUN_ID = "50000000-0000-4000-8000-000000000005";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_USER_ID = "10000000-0000-4000-8000-000000000002";
const TARGET_BOT_ID = "provider-bot-42";
const IDENTITY_AUTHORITY_ID = "provider-bot-directory-2026-08-23";
const RECORDED_AT = "2026-08-23T12:00:00.000Z";
const execFileAsync = promisify(execFile);
const collectorScript = fileURLToPath(
  new URL("./collect-agent-wake-evidence.mjs", import.meta.url),
);

function securityRecord(caseId = "security-cli-stdout", surface = "cli_stdout", overrides = {}) {
  return {
    version: 1,
    type: "agent.wake.rollout_evidence",
    recordedAt: RECORDED_AT,
    runId: RUN_ID,
    caseId,
    scenario: "security",
    result: "pass",
    gitCommit: "a".repeat(40),
    appVersion: "0.1.0",
    buildFlavor: "production",
    platform: "darwin",
    architecture: "arm64",
    clockSkewMs: 0,
    wakeHostId: "wake-host-primary",
    enrollmentId: "actual-grok-bot-wake",
    agentIdentityLabel: "Woots-production",
    targetKind: "grok_bot",
    targetBotId: TARGET_BOT_ID,
    targetIdentityAuthorityId: IDENTITY_AUTHORITY_ID,
    adapterId: "grok-bot-event-routine-v1",
    workspaceId: WORKSPACE_ID,
    agentUserId: AGENT_USER_ID,
    conversationId: null,
    messageId: null,
    wakeId: null,
    reason: null,
    sourceCursor: "10",
    attempt: null,
    messageCommittedAt: null,
    brokerDurableAt: null,
    providerAcceptedAt: null,
    latencyMs: null,
    providerReceiptKind: "none",
    providerReceiptId: null,
    providerActivityId: null,
    providerActivityObservedAt: null,
    exactMessageFetchEvidenceId: null,
    repairCode: null,
    operatorAction: null,
    caseEvidence: {
      type: "security_scan",
      authorityKind: "independent_security_review",
      authorityId: "security-review-2026-08-23",
      observationId: `observation-${caseId}`,
      observedAt: RECORDED_AT,
      surface,
      messageBodyMatches: 0,
      promptMatches: 0,
      historyMatches: 0,
      agentTokenMatches: 0,
      providerCredentialMatches: 0,
      childOutputMatches: 0,
      credentialHandleMatches: 0,
    },
    evidenceReference: `artifact-${caseId}`,
    ...overrides,
  };
}

async function privateJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "hype-wake-collector-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const runDirectory = path.join(parent, "run");
  await initializeAgentWakeEvidenceRun(runDirectory);
  const subjectPath = path.join(parent, "authority-subject.json");
  await privateJson(subjectPath, { auditId: "security-review-2026-08-23" });
  const observationPath = path.join(parent, "observation.json");
  const writeObservation = async (record, authoritySubjectPath = subjectPath) => {
    await privateJson(observationPath, {
      version: 1,
      type: "agent.wake.evidence_observation",
      authoritySubjectPath,
      record,
    });
  };
  return { parent, runDirectory, subjectPath, observationPath, writeObservation };
}

function expectCollectorCode(code) {
  return (error) => error instanceof AgentWakeEvidenceCollectorError && error.code === code;
}

test("collects one strict record and a subject-bound private authority pointer", async (t) => {
  const setup = await fixture(t);
  await setup.writeObservation(securityRecord());

  const result = await collectAgentWakeEvidenceObservation({
    runDirectory: setup.runDirectory,
    observationPath: setup.observationPath,
  });

  assert.deepEqual(result, {
    caseId: "security-cli-stdout",
    evidenceReference: "artifact-security-cli-stdout",
    duplicate: false,
    recordCount: 1,
  });
  const snapshot = await snapshotAgentWakeEvidenceRun({
    runDirectory: setup.runDirectory,
    validateComplete: false,
  });
  assert.equal(snapshot.recordCount, 1);
  const manifest = await readFile(snapshot.manifestPath, "utf8");
  const [record] = parseAgentWakeEvidenceManifest(manifest);
  const artifactPath = path.join(setup.runDirectory, "artifacts", record.evidenceReference);
  const artifact = await readFile(artifactPath);
  const pointer = JSON.parse(artifact.toString("utf8"));
  const subject = await readFile(setup.subjectPath);

  assert.equal(record.evidenceDigestSha256, createHash("sha256").update(artifact).digest("hex"));
  assert.equal(pointer.subjectDigestSha256, createHash("sha256").update(subject).digest("hex"));
  assert.deepEqual(
    {
      run: (await stat(setup.runDirectory)).mode & 0o777,
      artifact: (await stat(artifactPath)).mode & 0o777,
    },
    { run: 0o700, artifact: 0o600 },
  );
});

test("is idempotent for the same observation and refuses conflicting case reuse", async (t) => {
  const setup = await fixture(t);
  await setup.writeObservation(securityRecord());
  await collectAgentWakeEvidenceObservation({
    runDirectory: setup.runDirectory,
    observationPath: setup.observationPath,
  });

  const duplicate = await collectAgentWakeEvidenceObservation({
    runDirectory: setup.runDirectory,
    observationPath: setup.observationPath,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.recordCount, 1);

  await setup.writeObservation(
    securityRecord("security-cli-stdout", "cli_stdout", { sourceCursor: "11" }),
  );
  await assert.rejects(
    collectAgentWakeEvidenceObservation({
      runDirectory: setup.runDirectory,
      observationPath: setup.observationPath,
    }),
    expectCollectorCode("case-id-conflict"),
  );
});

test("rejects a non-schema field before creating a journal entry", async (t) => {
  const setup = await fixture(t);
  await setup.writeObservation({ ...securityRecord(), body: "must-not-enter-evidence" });

  await assert.rejects(
    collectAgentWakeEvidenceObservation({
      runDirectory: setup.runDirectory,
      observationPath: setup.observationPath,
    }),
    expectCollectorCode("record-invalid"),
  );
  assert.deepEqual(await readdirNames(path.join(setup.runDirectory, "records")), []);
  assert.deepEqual(await readdirNames(path.join(setup.runDirectory, "artifacts")), []);
});

test(
  "rejects a FIFO observation without blocking while holding the collector lock",
  { skip: process.platform === "win32", timeout: 2_000 },
  async (t) => {
    const setup = await fixture(t);
    await execFileAsync("mkfifo", [setup.observationPath]);
    await chmod(setup.observationPath, 0o600);

    await assert.rejects(
      collectAgentWakeEvidenceObservation({
        runDirectory: setup.runDirectory,
        observationPath: setup.observationPath,
      }),
      expectCollectorCode("observation-invalid"),
    );
  },
);

test("rejects a symlinked authority subject and a changed run identity", async (t) => {
  const setup = await fixture(t);
  const subjectLink = path.join(setup.parent, "authority-link.json");
  await symlink(setup.subjectPath, subjectLink);
  await setup.writeObservation(securityRecord(), subjectLink);
  await assert.rejects(
    collectAgentWakeEvidenceObservation({
      runDirectory: setup.runDirectory,
      observationPath: setup.observationPath,
    }),
    expectCollectorCode("authority-subject-invalid"),
  );

  await setup.writeObservation(securityRecord());
  await collectAgentWakeEvidenceObservation({
    runDirectory: setup.runDirectory,
    observationPath: setup.observationPath,
  });
  const changedRun = securityRecord("security-durable-state", "durable_state", {
    recordedAt: "2026-08-23T12:01:00.000Z",
    runId: "50000000-0000-4000-8000-000000000006",
    sourceCursor: "11",
  });
  changedRun.caseEvidence.observedAt = changedRun.recordedAt;
  await setup.writeObservation(changedRun);
  await assert.rejects(
    collectAgentWakeEvidenceObservation({
      runDirectory: setup.runDirectory,
      observationPath: setup.observationPath,
    }),
    expectCollectorCode("run-field-changed:runId"),
  );
});

test("failed finalize validates a private candidate without publishing it", async (t) => {
  const setup = await fixture(t);
  await setup.writeObservation(securityRecord());
  await collectAgentWakeEvidenceObservation({
    runDirectory: setup.runDirectory,
    observationPath: setup.observationPath,
  });

  await assert.rejects(
    snapshotAgentWakeEvidenceRun({ runDirectory: setup.runDirectory, validateComplete: true }),
    (error) => error instanceof AgentWakeEvidenceManifestError,
  );
  await assert.rejects(readFile(path.join(setup.runDirectory, "rollout.ndjson")), (error) => {
    return (
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
  });
});

test("a journal append invalidates the published manifest but an exact retry does not", async (t) => {
  const setup = await fixture(t);
  await setup.writeObservation(securityRecord());
  await collectAgentWakeEvidenceObservation({
    runDirectory: setup.runDirectory,
    observationPath: setup.observationPath,
  });
  const firstSnapshot = await snapshotAgentWakeEvidenceRun({
    runDirectory: setup.runDirectory,
    validateComplete: false,
  });
  const published = await readFile(firstSnapshot.manifestPath);

  await collectAgentWakeEvidenceObservation({
    runDirectory: setup.runDirectory,
    observationPath: setup.observationPath,
  });
  assert.deepEqual(await readFile(firstSnapshot.manifestPath), published);
  await assert.rejects(
    snapshotAgentWakeEvidenceRun({ runDirectory: setup.runDirectory, validateComplete: true }),
    (error) => error instanceof AgentWakeEvidenceManifestError,
  );
  assert.deepEqual(await readFile(firstSnapshot.manifestPath), published);

  const second = securityRecord("security-durable-state", "durable_state", {
    recordedAt: "2026-08-23T12:01:00.000Z",
    sourceCursor: "11",
  });
  second.caseEvidence.observedAt = second.recordedAt;
  await setup.writeObservation(second);
  await collectAgentWakeEvidenceObservation({
    runDirectory: setup.runDirectory,
    observationPath: setup.observationPath,
  });
  await assert.rejects(readFile(firstSnapshot.manifestPath), (error) => {
    return (
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
  });
});

test("snapshot detects duplicate journal entries and artifact tampering", async (t) => {
  const setup = await fixture(t);
  await setup.writeObservation(securityRecord());
  await collectAgentWakeEvidenceObservation({
    runDirectory: setup.runDirectory,
    observationPath: setup.observationPath,
  });

  const firstJournalPath = path.join(setup.runDirectory, "records", "00001.ndjson");
  const duplicateJournalPath = path.join(setup.runDirectory, "records", "00002.ndjson");
  await writeFile(duplicateJournalPath, await readFile(firstJournalPath), { mode: 0o600 });
  await assert.rejects(
    snapshotAgentWakeEvidenceRun({ runDirectory: setup.runDirectory, validateComplete: false }),
    expectCollectorCode("case-id-reused"),
  );
  await rm(duplicateJournalPath);

  const artifactPath = path.join(setup.runDirectory, "artifacts", "artifact-security-cli-stdout");
  await privateJson(artifactPath, { tampered: true });
  await assert.rejects(
    snapshotAgentWakeEvidenceRun({ runDirectory: setup.runDirectory, validateComplete: false }),
    expectCollectorCode("artifact-digest-mismatch"),
  );
});

test("CLI initializes, collects, and snapshots a private run", async (t) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "hype-wake-collector-cli-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const runDirectory = path.join(parent, "run");
  const subjectPath = path.join(parent, "authority-subject.json");
  const observationPath = path.join(parent, "observation.json");
  await privateJson(subjectPath, { auditId: "security-review-2026-08-23" });
  await privateJson(observationPath, {
    version: 1,
    type: "agent.wake.evidence_observation",
    authoritySubjectPath: subjectPath,
    record: securityRecord(),
  });

  const initialized = await execFileAsync(process.execPath, [
    collectorScript,
    "init",
    "--run-directory",
    runDirectory,
  ]);
  assert.deepEqual(JSON.parse(initialized.stdout), {
    version: 1,
    type: "agent.wake.collector_result",
    action: "init",
    ok: true,
  });

  const collected = await execFileAsync(process.execPath, [
    collectorScript,
    "collect",
    "--run-directory",
    runDirectory,
    "--observation",
    observationPath,
  ]);
  assert.deepEqual(JSON.parse(collected.stdout), {
    version: 1,
    type: "agent.wake.collector_result",
    action: "collect",
    ok: true,
    caseId: "security-cli-stdout",
    evidenceReference: "artifact-security-cli-stdout",
    duplicate: false,
    recordCount: 1,
  });

  const snapshot = await execFileAsync(process.execPath, [
    collectorScript,
    "snapshot",
    "--run-directory",
    runDirectory,
  ]);
  assert.deepEqual(JSON.parse(snapshot.stdout), {
    version: 1,
    type: "agent.wake.collector_result",
    action: "snapshot",
    ok: true,
    recordCount: 1,
  });
  assert.equal(
    parseAgentWakeEvidenceManifest(
      await readFile(path.join(runDirectory, "rollout.ndjson"), "utf8"),
    ).length,
    1,
  );
});

test("initialization rejects a group-writable ancestor", async (t) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "hype-wake-unsafe-parent-")));
  t.after(async () => {
    await chmod(parent, 0o700).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });
  await chmod(parent, 0o770);

  await assert.rejects(
    initializeAgentWakeEvidenceRun(path.join(parent, "run")),
    expectCollectorCode("run-directory-invalid"),
  );
});

test("ancestor policy permits only root-owned sticky writable directories", () => {
  assert.equal(isSafeAgentWakeEvidenceAncestor({ mode: 0o40700n, uid: 501n }), true);
  assert.equal(isSafeAgentWakeEvidenceAncestor({ mode: 0o41777n, uid: 0n }), true);
  assert.equal(isSafeAgentWakeEvidenceAncestor({ mode: 0o40777n, uid: 0n }), false);
  assert.equal(isSafeAgentWakeEvidenceAncestor({ mode: 0o41777n, uid: 501n }), false);
});

test("initialization accepts a private run below the standard temporary root", async (t) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "hype-wake-temp-parent-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const runDirectory = path.join(parent, "run");

  await initializeAgentWakeEvidenceRun(runDirectory);

  assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
});

test("initialization rejects a non-canonical absolute path spelling", async (t) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "hype-wake-path-parent-")));
  t.after(() => rm(parent, { recursive: true, force: true }));

  await assert.rejects(
    initializeAgentWakeEvidenceRun(`${parent}/unused/../run`),
    expectCollectorCode("run-directory-invalid"),
  );
});

async function readdirNames(directoryPath) {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(directoryPath)).filter((name) => !name.startsWith(".tmp-"));
}
