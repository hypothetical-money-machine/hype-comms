import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentWakeEvidenceManifestError,
  parseAgentWakeEvidenceManifest,
  validateAgentWakeAuthorityReferenceArtifact,
  validateAgentWakeEvidenceManifest,
} from "./validate-agent-wake-evidence-manifest.mjs";

const MAX_OBSERVATION_BYTES = 64 * 1_024;
const MAX_AUTHORITY_SUBJECT_BYTES = 64 * 1_024 * 1_024;
const MAX_COLLECTOR_LOCK_BYTES = 1_024;
const MAX_RECORDS = 20_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const JOURNAL_FILE_PATTERN = /^(?<index>[0-9]{5})\.ndjson$/u;
const COLLECTOR_LOCK_NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COLLECTOR_LOCK_FILE_PATTERN =
  /^\.collector-lock-(?<nonce>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const CONSTANT_RUN_FIELDS = [
  "runId",
  "gitCommit",
  "appVersion",
  "buildFlavor",
  "platform",
  "architecture",
  "enrollmentId",
  "agentIdentityLabel",
  "adapterId",
  "targetKind",
  "targetBotId",
  "targetIdentityAuthorityId",
  "workspaceId",
  "agentUserId",
];

export class AgentWakeEvidenceCollectorError extends Error {
  constructor(code) {
    super(`Agent Wake evidence collection failed: ${code}`);
    this.name = "AgentWakeEvidenceCollectorError";
    this.code = code;
  }
}

function fail(code) {
  throw new AgentWakeEvidenceCollectorError(code);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sameMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function expectedOwner(metadata) {
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  return currentUid === null || metadata.uid === currentUid || metadata.uid === 0n;
}

function ownedPrivately(metadata, expectedMode) {
  return (metadata.mode & 0o777n) === BigInt(expectedMode) && expectedOwner(metadata);
}

function isErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function classifyAgentWakeCollectorLockOwner(pid, signalProcess = process.kill) {
  try {
    signalProcess(pid, 0);
    // A live PID may be the original collector or an unrelated process that reused the PID. Both
    // are deliberately non-reclaimable because the collector cannot distinguish them safely.
    return "live_or_reused";
  } catch (error) {
    return isErrorCode(error, "ESRCH") ? "gone" : "ambiguous";
  }
}

export function isSafeAgentWakeEvidenceAncestor(metadata) {
  if ((metadata.mode & 0o22n) === 0n) return true;
  // Standard temporary roots such as Linux /tmp are safe for a randomly named private child:
  // root owns the ancestor and the sticky bit prevents other users from renaming that child.
  return metadata.uid === 0n && (metadata.mode & 0o1000n) !== 0n;
}

function requiredAbsolutePath(value, code) {
  const resolved = typeof value === "string" ? path.resolve(value) : null;
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    resolved !== value ||
    resolved === path.parse(resolved).root
  ) {
    fail(code);
  }
  return resolved;
}

async function syncDirectory(directoryPath) {
  const handle = await open(directoryPath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifySafeAncestorDirectories(targetPath, includeTarget, code) {
  let current = includeTarget ? path.resolve(targetPath) : path.dirname(path.resolve(targetPath));
  const directories = [];
  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directoryPath of directories.reverse()) {
    let metadata;
    try {
      metadata = await lstat(directoryPath, { bigint: true });
    } catch {
      fail(code);
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !expectedOwner(metadata) ||
      !isSafeAgentWakeEvidenceAncestor(metadata)
    ) {
      fail(code);
    }
  }
}

async function verifyPrivateDirectory(directoryPath, code) {
  const resolved = requiredAbsolutePath(directoryPath, code);
  await verifySafeAncestorDirectories(resolved, true, code);
  let metadata;
  let canonical;
  try {
    [metadata, canonical] = await Promise.all([
      lstat(resolved, { bigint: true }),
      realpath(resolved),
    ]);
  } catch {
    fail(code);
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !ownedPrivately(metadata, PRIVATE_DIRECTORY_MODE) ||
    canonical !== resolved
  ) {
    fail(code);
  }
  return resolved;
}

async function readPrivateStableFile(filePath, maximumBytes, code) {
  const resolved = requiredAbsolutePath(filePath, code);
  await verifySafeAncestorDirectories(resolved, false, code);
  let canonical;
  try {
    canonical = await realpath(resolved);
  } catch {
    fail(code);
  }
  if (canonical !== resolved) fail(code);

  let handle;
  try {
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    fail(code);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size <= 0n ||
      before.size > BigInt(maximumBytes) ||
      !ownedPrivately(before, PRIVATE_FILE_MODE)
    ) {
      fail(code);
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameMetadata(before, after)) fail(code);
    return content;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function decodeUtf8(content, code) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    fail(code);
  }
}

async function writeNewFileAtomically(directoryPath, fileName, content, conflictCode) {
  const finalPath = path.join(directoryPath, fileName);
  const temporaryPath = path.join(directoryPath, `.tmp-${randomUUID()}`);
  let temporaryHandle;
  try {
    temporaryHandle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await temporaryHandle.writeFile(content);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await link(temporaryPath, finalPath);
    await syncDirectory(directoryPath);
    return finalPath;
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      fail(conflictCode);
    }
    if (error instanceof AgentWakeEvidenceCollectorError) throw error;
    fail("durable-write-failed");
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function ensureExactArtifact(artifactDirectory, fileName, content) {
  const artifactPath = path.join(artifactDirectory, fileName);
  try {
    await writeNewFileAtomically(artifactDirectory, fileName, content, "artifact-exists");
    return artifactPath;
  } catch (error) {
    if (!(error instanceof AgentWakeEvidenceCollectorError) || error.code !== "artifact-exists") {
      throw error;
    }
    const existing = await readPrivateStableFile(
      artifactPath,
      MAX_OBSERVATION_BYTES,
      "artifact-conflict",
    );
    if (!existing.equals(content)) fail("artifact-conflict");
    return artifactPath;
  }
}

async function publishManifestAtomically(paths, content, validateComplete) {
  const temporaryPath = path.join(paths.run, `.tmp-${randomUUID()}`);
  let handle;
  try {
    try {
      const existing = await lstat(paths.manifest, { bigint: true });
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        !ownedPrivately(existing, PRIVATE_FILE_MODE)
      ) {
        fail("manifest-path-invalid");
      }
    } catch (error) {
      if (error instanceof AgentWakeEvidenceCollectorError || !isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const summary = validateComplete
      ? await validateAgentWakeEvidenceManifest(temporaryPath, paths.artifacts)
      : null;
    await rename(temporaryPath, paths.manifest);
    await syncDirectory(paths.run);
    return summary;
  } catch (error) {
    if (
      error instanceof AgentWakeEvidenceCollectorError ||
      error instanceof AgentWakeEvidenceManifestError
    ) {
      throw error;
    }
    fail("manifest-write-failed");
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function invalidatePublishedManifest(paths) {
  let metadata;
  try {
    metadata = await lstat(paths.manifest, { bigint: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    fail("manifest-invalidation-failed");
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !ownedPrivately(metadata, PRIVATE_FILE_MODE)
  ) {
    fail("manifest-path-invalid");
  }
  try {
    await unlink(paths.manifest);
    await syncDirectory(paths.run);
  } catch {
    fail("manifest-invalidation-failed");
  }
}

function parseCollectorLock(content, expectedNonce) {
  const text = decodeUtf8(content, "collector-lock-unavailable");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("collector-lock-unavailable");
  }
  if (
    text !== `${JSON.stringify(value)}\n` ||
    !hasExactKeys(value, ["nonce", "pid", "version"]) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    value.pid > 2_147_483_647 ||
    typeof value.nonce !== "string" ||
    !COLLECTOR_LOCK_NONCE_PATTERN.test(value.nonce) ||
    value.nonce !== expectedNonce
  ) {
    fail("collector-lock-unavailable");
  }
  return value;
}

async function readCollectorLock(lockPath, expectedNonce) {
  const content = await readPrivateStableFile(
    lockPath,
    MAX_COLLECTOR_LOCK_BYTES,
    "collector-lock-unavailable",
  );
  return { content, record: parseCollectorLock(content, expectedNonce) };
}

async function removeCollectorLockIfOwned(runDirectory, lockPath, expectedNonce, expectedContent) {
  let current;
  try {
    current = await readCollectorLock(lockPath, expectedNonce);
  } catch {
    return false;
  }
  if (!current.content.equals(expectedContent)) return false;
  try {
    await unlink(lockPath);
    await syncDirectory(runDirectory);
    return true;
  } catch {
    return false;
  }
}

async function publishCollectorLock(runDirectory, nonce, content) {
  const lockPath = path.join(runDirectory, `.collector-lock-${nonce}.json`);
  const temporaryPath = path.join(runDirectory, `.collector-lock-stage-${nonce}`);
  let handle;
  let linked = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, lockPath);
    linked = true;
    await unlink(temporaryPath);
    await syncDirectory(runDirectory);
    return lockPath;
  } catch (error) {
    if (linked) await removeCollectorLockIfOwned(runDirectory, lockPath, nonce, content);
    if (error instanceof AgentWakeEvidenceCollectorError) throw error;
    fail("collector-lock-unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function reclaimStaleCollectorLock(runDirectory, lockPath, nonce) {
  const before = await readCollectorLock(lockPath, nonce);
  const firstLivenessCheck = classifyAgentWakeCollectorLockOwner(before.record.pid);
  const secondLivenessCheck = classifyAgentWakeCollectorLockOwner(before.record.pid);
  if (firstLivenessCheck !== "gone" || secondLivenessCheck !== "gone") {
    fail("collector-lock-unavailable");
  }
  // A UUID lock pathname is never reused, so removing this exact stale contender cannot unlink a
  // later owner's lock. The two liveness checks remain conservative about PID reuse.
  if (!(await removeCollectorLockIfOwned(runDirectory, lockPath, nonce, before.content))) {
    fail("collector-lock-unavailable");
  }
}

async function acquireCollectorLock(runDirectory) {
  const nonce = randomUUID();
  const content = Buffer.from(
    `${JSON.stringify({ version: 1, pid: process.pid, nonce })}\n`,
    "utf8",
  );
  const lockPath = await publishCollectorLock(runDirectory, nonce, content);
  try {
    const names = await readdir(runDirectory);
    if (names.includes(".collector.lock")) fail("collector-lock-unavailable");
    for (const name of names.sort()) {
      const match = COLLECTOR_LOCK_FILE_PATTERN.exec(name);
      if (match === null) {
        if (name.startsWith(".collector-lock-") && !name.startsWith(".collector-lock-stage-")) {
          fail("collector-lock-unavailable");
        }
        continue;
      }
      const contenderNonce = match.groups?.nonce;
      if (contenderNonce === undefined || contenderNonce === nonce) continue;
      await reclaimStaleCollectorLock(runDirectory, path.join(runDirectory, name), contenderNonce);
    }
  } catch (error) {
    if (!(await removeCollectorLockIfOwned(runDirectory, lockPath, nonce, content))) {
      fail("collector-lock-unavailable");
    }
    throw error;
  }
  return async () => {
    if (!(await removeCollectorLockIfOwned(runDirectory, lockPath, nonce, content))) {
      fail("collector-lock-release-failed");
    }
  };
}

async function withCollectorLock(runDirectory, operation) {
  const release = await acquireCollectorLock(runDirectory);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function collectorPaths(runDirectory) {
  return {
    artifacts: path.join(runDirectory, "artifacts"),
    records: path.join(runDirectory, "records"),
    manifest: path.join(runDirectory, "rollout.ndjson"),
  };
}

async function verifyRunDirectory(runDirectory) {
  const run = await verifyPrivateDirectory(runDirectory, "run-directory-invalid");
  const paths = collectorPaths(run);
  await Promise.all([
    verifyPrivateDirectory(paths.artifacts, "artifact-directory-invalid"),
    verifyPrivateDirectory(paths.records, "record-directory-invalid"),
  ]);
  return { run, ...paths };
}

export async function initializeAgentWakeEvidenceRun(runDirectory) {
  const run = requiredAbsolutePath(runDirectory, "run-directory-invalid");
  await verifySafeAncestorDirectories(run, false, "run-directory-invalid");
  try {
    await mkdir(run, { mode: PRIVATE_DIRECTORY_MODE }).catch((error) => {
      if (!isErrorCode(error, "EEXIST")) throw error;
    });
    await mkdir(path.join(run, "artifacts"), { mode: PRIVATE_DIRECTORY_MODE }).catch((error) => {
      if (!isErrorCode(error, "EEXIST")) throw error;
    });
    await mkdir(path.join(run, "records"), { mode: PRIVATE_DIRECTORY_MODE }).catch((error) => {
      if (!isErrorCode(error, "EEXIST")) throw error;
    });
    await syncDirectory(run);
    await syncDirectory(path.dirname(run));
  } catch {
    fail("run-directory-create-failed");
  }
  await verifyRunDirectory(run);
  return { runDirectory: run };
}

async function loadJournalRecords(paths) {
  let entries;
  try {
    entries = await readdir(paths.records, { withFileTypes: true });
  } catch {
    fail("record-journal-unavailable");
  }
  const numbered = [];
  for (const entry of entries) {
    const match = JOURNAL_FILE_PATTERN.exec(entry.name);
    if (match === null) {
      if (entry.name.startsWith(".tmp-")) continue;
      fail("record-journal-entry-invalid");
    }
    if (!entry.isFile()) fail("record-journal-entry-invalid");
    numbered.push({ name: entry.name, index: Number(match.groups.index) });
  }
  numbered.sort((left, right) => left.index - right.index);
  if (numbered.length > MAX_RECORDS) fail("record-limit");

  const records = [];
  for (const [offset, entry] of numbered.entries()) {
    if (entry.index !== offset + 1) fail("record-journal-sequence-invalid");
    const content = await readPrivateStableFile(
      path.join(paths.records, entry.name),
      MAX_OBSERVATION_BYTES,
      "record-journal-entry-invalid",
    );
    let parsed;
    try {
      parsed = parseAgentWakeEvidenceManifest(decodeUtf8(content, "record-journal-entry-invalid"));
    } catch {
      fail("record-journal-entry-invalid");
    }
    if (parsed.length !== 1) fail("record-journal-entry-invalid");
    records.push(parsed[0]);
  }
  validateJournalPrefix(records);
  return records;
}

function authorityReference(record, subjectDigestSha256) {
  return {
    version: 1,
    type: "agent.wake.authority_reference",
    runId: record.runId,
    caseId: record.caseId,
    targetBotId: record.targetBotId,
    targetIdentityAuthorityId: record.targetIdentityAuthorityId,
    authorityKind: record.caseEvidence.authorityKind,
    authorityId: record.caseEvidence.authorityId,
    observationId: record.caseEvidence.observationId,
    subjectDigestSha256,
    independentReviewRequired: true,
  };
}

async function verifyArtifactForRecord(paths, record, expectedContent = null) {
  const artifactPath = path.join(paths.artifacts, record.evidenceReference);
  const content = await readPrivateStableFile(
    artifactPath,
    MAX_OBSERVATION_BYTES,
    "artifact-invalid",
  );
  if (expectedContent !== null && !content.equals(expectedContent)) fail("artifact-conflict");
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== record.evidenceDigestSha256) fail("artifact-digest-mismatch");
  try {
    validateAgentWakeAuthorityReferenceArtifact(content, record);
  } catch {
    fail("artifact-invalid");
  }
}

function validateJournalPrefix(records) {
  const caseIds = new Set();
  const evidenceReferences = new Set();
  const observationIds = new Set();
  const first = records[0];
  let priorRecordedAt = -Infinity;
  for (const record of records) {
    if (caseIds.has(record.caseId)) fail("case-id-reused");
    if (evidenceReferences.has(record.evidenceReference)) fail("evidence-reference-reused");
    if (observationIds.has(record.caseEvidence.observationId)) fail("observation-id-reused");
    caseIds.add(record.caseId);
    evidenceReferences.add(record.evidenceReference);
    observationIds.add(record.caseEvidence.observationId);
    for (const field of CONSTANT_RUN_FIELDS) {
      if (record[field] !== first[field]) fail(`run-field-changed:${field}`);
    }
    const recordedAt = Date.parse(record.recordedAt) - record.clockSkewMs;
    if (recordedAt < priorRecordedAt) fail("record-not-chronological");
    priorRecordedAt = recordedAt;
  }
}

function validatePrefix(records, candidate) {
  if (records.length >= MAX_RECORDS) fail("record-limit");
  const existingCase = records.find((record) => record.caseId === candidate.caseId);
  if (existingCase !== undefined) return existingCase;
  validateJournalPrefix([...records, candidate]);
  return null;
}

async function loadObservation(observationPath) {
  const content = await readPrivateStableFile(
    observationPath,
    MAX_OBSERVATION_BYTES,
    "observation-invalid",
  );
  const text = decodeUtf8(content, "observation-invalid");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("observation-invalid");
  }
  if (
    text !== `${JSON.stringify(value)}\n` ||
    !hasExactKeys(value, ["authoritySubjectPath", "record", "type", "version"]) ||
    value.version !== 1 ||
    value.type !== "agent.wake.evidence_observation" ||
    !isPlainObject(value.record) ||
    Object.hasOwn(value.record, "evidenceDigestSha256")
  ) {
    fail("observation-invalid");
  }
  const subjectPath = requiredAbsolutePath(value.authoritySubjectPath, "authority-subject-invalid");
  return { record: value.record, subjectPath };
}

function parseCandidate(record, digest) {
  let parsed;
  try {
    parsed = parseAgentWakeEvidenceManifest(
      `${JSON.stringify({ ...record, evidenceDigestSha256: digest })}\n`,
    );
  } catch {
    fail("record-invalid");
  }
  if (parsed.length !== 1) fail("record-invalid");
  return parsed[0];
}

export async function collectAgentWakeEvidenceObservation(options) {
  const paths = await verifyRunDirectory(options.runDirectory);
  const observationPath = requiredAbsolutePath(options.observationPath, "observation-invalid");
  return withCollectorLock(paths.run, async () => {
    const existingRecords = await loadJournalRecords(paths);
    for (const record of existingRecords) await verifyArtifactForRecord(paths, record);

    const observation = await loadObservation(observationPath);
    // Validate shape and case semantics before reading or retaining any authority subject.
    const provisional = parseCandidate(observation.record, "0".repeat(64));
    const subject = await readPrivateStableFile(
      observation.subjectPath,
      MAX_AUTHORITY_SUBJECT_BYTES,
      "authority-subject-invalid",
    );
    const subjectDigest = createHash("sha256").update(subject).digest("hex");
    const pointerContent = Buffer.from(
      `${JSON.stringify(authorityReference(provisional, subjectDigest))}\n`,
      "utf8",
    );
    const evidenceDigest = createHash("sha256").update(pointerContent).digest("hex");
    const record = parseCandidate(observation.record, evidenceDigest);
    const existingCase = validatePrefix(existingRecords, record);
    if (existingCase !== null) {
      if (JSON.stringify(existingCase) !== JSON.stringify(record)) fail("case-id-conflict");
      await verifyArtifactForRecord(paths, existingCase, pointerContent);
      return {
        caseId: record.caseId,
        evidenceReference: record.evidenceReference,
        duplicate: true,
        recordCount: existingRecords.length,
      };
    }

    await ensureExactArtifact(paths.artifacts, record.evidenceReference, pointerContent);
    await verifyArtifactForRecord(paths, record, pointerContent);
    const journalName = `${String(existingRecords.length + 1).padStart(5, "0")}.ndjson`;
    // Invalidate first so a crash can never leave an older snapshot beside a newer journal.
    await invalidatePublishedManifest(paths);
    await writeNewFileAtomically(
      paths.records,
      journalName,
      Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
      "record-journal-conflict",
    );
    return {
      caseId: record.caseId,
      evidenceReference: record.evidenceReference,
      duplicate: false,
      recordCount: existingRecords.length + 1,
    };
  });
}

export async function snapshotAgentWakeEvidenceRun(options) {
  const paths = await verifyRunDirectory(options.runDirectory);
  return withCollectorLock(paths.run, async () => {
    const records = await loadJournalRecords(paths);
    if (records.length === 0) fail("record-journal-empty");
    for (const record of records) await verifyArtifactForRecord(paths, record);
    const content = Buffer.from(
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const summary = await publishManifestAtomically(
      paths,
      content,
      options.validateComplete === true,
    );
    return { manifestPath: paths.manifest, recordCount: records.length, summary };
  });
}

function parseArguments(args) {
  if (
    args.length === 3 &&
    args[0] === "init" &&
    args[1] === "--run-directory" &&
    path.isAbsolute(args[2])
  ) {
    return { action: "init", runDirectory: args[2] };
  }
  if (
    args.length === 5 &&
    args[0] === "collect" &&
    args[1] === "--run-directory" &&
    path.isAbsolute(args[2]) &&
    args[3] === "--observation" &&
    path.isAbsolute(args[4])
  ) {
    return { action: "collect", runDirectory: args[2], observationPath: args[4] };
  }
  if (
    args.length === 3 &&
    (args[0] === "snapshot" || args[0] === "finalize") &&
    args[1] === "--run-directory" &&
    path.isAbsolute(args[2])
  ) {
    return { action: args[0], runDirectory: args[2] };
  }
  fail("usage");
}

async function runCli(args) {
  const command = parseArguments(args);
  if (command.action === "init") {
    await initializeAgentWakeEvidenceRun(command.runDirectory);
    return { version: 1, type: "agent.wake.collector_result", action: "init", ok: true };
  }
  if (command.action === "collect") {
    const result = await collectAgentWakeEvidenceObservation(command);
    return {
      version: 1,
      type: "agent.wake.collector_result",
      action: "collect",
      ok: true,
      ...result,
    };
  }
  const result = await snapshotAgentWakeEvidenceRun({
    runDirectory: command.runDirectory,
    validateComplete: command.action === "finalize",
  });
  return {
    version: 1,
    type: "agent.wake.collector_result",
    action: command.action,
    ok: true,
    recordCount: result.recordCount,
    ...(result.summary === null ? {} : { summary: result.summary }),
  };
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) {
  try {
    console.log(JSON.stringify(await runCli(process.argv.slice(2))));
  } catch (error) {
    console.error(
      error instanceof AgentWakeEvidenceCollectorError ||
        error instanceof AgentWakeEvidenceManifestError
        ? error.message
        : "Agent Wake evidence collection failed: collector-error",
    );
    process.exitCode = 1;
  }
}
