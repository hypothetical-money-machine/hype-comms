import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { valid as validSemver } from "semver";

const MAX_EVIDENCE_BYTES = 64 * 1_024 * 1_024;
const MAX_RECORDS = 20_000;
const MAX_LINE_BYTES = 32 * 1_024;
const MAX_AUTHORITY_REFERENCE_BYTES = 32 * 1_024;
const ARTIFACT_HASH_BUFFER_BYTES = 64 * 1_024;
const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const SIXTEEN_MINUTES_MS = 16 * 60 * 1_000;
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

const expectedKeys = [
  "adapterId",
  "agentIdentityLabel",
  "agentUserId",
  "appVersion",
  "architecture",
  "attempt",
  "brokerDurableAt",
  "buildFlavor",
  "caseId",
  "caseEvidence",
  "clockSkewMs",
  "conversationId",
  "enrollmentId",
  "evidenceDigestSha256",
  "evidenceReference",
  "exactMessageFetchEvidenceId",
  "gitCommit",
  "latencyMs",
  "messageCommittedAt",
  "messageId",
  "operatorAction",
  "platform",
  "providerAcceptedAt",
  "providerActivityId",
  "providerActivityObservedAt",
  "providerReceiptId",
  "providerReceiptKind",
  "reason",
  "recordedAt",
  "repairCode",
  "result",
  "runId",
  "scenario",
  "sourceCursor",
  "targetBotId",
  "targetIdentityAuthorityId",
  "targetKind",
  "type",
  "version",
  "wakeHostId",
  "wakeId",
  "workspaceId",
].sort();

const scenarios = new Set([
  "direct_message",
  "verified_mention",
  "suppressed",
  "replay",
  "failure",
  "operator",
  "security",
  "integrity",
  "soak",
  "poll_retirement",
]);
const receiptKinds = new Set(["adapter_issued", "provider_issued", "none"]);
const reasons = new Set(["direct_message", "verified_mention"]);
const operatorActions = new Set([
  "confirm-accepted",
  "confirm-duplicate",
  "confirm-coalesced",
  "provider-retry",
  "source-reset-from-now",
  "resume",
]);
const placeholderAgentLabels = new Set([
  "agent",
  "bot",
  "example-bot",
  "grok-bot-pilot",
  "mock-bot",
  "test-bot",
  "unnamed",
]);
const desktopSliceAgentLabelPattern = /^(?:jules|wren)(?:[._:-]|$)/iu;
const authorityKinds = new Set([
  "apple_notary",
  "hype_comms_server",
  "host_process",
  "independent_security_review",
  "macos_codesign",
  "macos_package",
  "operator_audit",
  "provider_cli_correlation",
  "scheduler",
  "wake_broker",
]);
const suppressedCategories = [
  "self-authored-dm",
  "missing-author",
  "fake-text-mention",
  "unmentioned-group-dm",
  "unmentioned-channel",
  "participated-thread",
  "reaction",
  "task",
  "membership",
  "read",
  "system",
];

const exactCases = new Map([
  ["fresh-enrollment", "failure"],
  ["disconnect-replay", "failure"],
  ["cursor-expiry", "failure"],
  ["server-reset", "failure"],
  ["token-revocation", "failure"],
  ["enqueue-before-source-ack", "failure"],
  ["crash-before-target", "failure"],
  ["crash-after-possible-target", "failure"],
  ["fifo-ordering", "failure"],
  ["capacity-pause", "failure"],
  ["provider-retry-exhaustion", "failure"],
  ["completion-ledger-bound", "failure"],
  ["provider-ledger-bound", "failure"],
  ["fresh-auth-start", "failure"],
  ["fresh-auth-resume", "failure"],
  ["completion-store-recovery", "failure"],
  ["source-disconnect-reconnect-01", "failure"],
  ["source-disconnect-reconnect-02", "failure"],
  ["source-disconnect-reconnect-03", "failure"],
  ["source-disconnect-reconnect-04", "failure"],
  ["desktop-restart-01", "failure"],
  ["desktop-restart-02", "failure"],
  ["shutdown-child-reaping", "failure"],
  ["operator-status", "operator"],
  ["operator-confirm-accepted", "operator"],
  ["operator-confirm-duplicate", "operator"],
  ["operator-confirm-coalesced", "operator"],
  ["operator-provider-retry", "operator"],
  ["operator-source-reset-from-now", "operator"],
  ["operator-resume", "operator"],
  ["security-cli-stdout", "security"],
  ["security-durable-state", "security"],
  ["security-provider-stdin", "security"],
  ["security-renderer-ipc", "security"],
  ["security-structured-logs", "security"],
  ["security-rollout-evidence", "security"],
  ["security-credential-handles", "security"],
  ["executable-source-symlink-rejected", "integrity"],
  ["executable-target-symlink-rejected", "integrity"],
  ["executable-nonregular-rejected", "integrity"],
  ["executable-owner-rejected", "integrity"],
  ["executable-mode-rejected", "integrity"],
  ["executable-path-replacement-rejected", "integrity"],
  ["executable-ancestor-symlink-rejected", "integrity"],
  ["executable-ancestor-mode-rejected", "integrity"],
  ["executable-runtime-hash-rejected", "integrity"],
  ["executable-entrypoint-hash-rejected", "integrity"],
  ["executable-target-hash-rejected", "integrity"],
  ["executable-target-script-rejected", "integrity"],
  ["executable-target-unknown-load-command-rejected", "integrity"],
  ["executable-path-lookup-ignored", "integrity"],
  ["executable-root-owned-deployment", "integrity"],
  ["executable-native-arm64", "integrity"],
  ["cli-bundle-self-contained", "integrity"],
  ["runtime-signature", "integrity"],
  ["target-signature", "integrity"],
  ["host-election-single-active", "integrity"],
  ["host-controlled-failover", "integrity"],
  ["packaged-operator-interface", "integrity"],
  ["package-production-gate", "integrity"],
  ["package-updater-isolated", "integrity"],
  ["package-signature", "integrity"],
  ["package-notarization", "integrity"],
  ["package-install", "integrity"],
  ["soak-summary", "soak"],
  ["poll-inventory", "poll_retirement"],
  ["poll-disabled", "poll_retirement"],
  ["poll-interval-01-zero", "poll_retirement"],
  ["poll-interval-02-zero", "poll_retirement"],
  ["poll-two-intervals-zero", "poll_retirement"],
  ["poll-push-only-dm", "poll_retirement"],
  ["poll-push-only-mention", "poll_retirement"],
]);

const expectedOperatorActions = new Map([
  ["operator-confirm-accepted", "confirm-accepted"],
  ["operator-confirm-duplicate", "confirm-duplicate"],
  ["operator-confirm-coalesced", "confirm-coalesced"],
  ["operator-provider-retry", "provider-retry"],
  ["operator-source-reset-from-now", "source-reset-from-now"],
  ["operator-resume", "resume"],
]);

const securitySurfaces = new Map([
  ["security-cli-stdout", "cli_stdout"],
  ["security-durable-state", "durable_state"],
  ["security-provider-stdin", "provider_stdin"],
  ["security-renderer-ipc", "renderer_ipc"],
  ["security-structured-logs", "structured_logs"],
  ["security-rollout-evidence", "rollout_evidence"],
  ["security-credential-handles", "credential_handle_projection"],
]);

const caseObservationRequirements = new Map([
  ["fresh-enrollment", ["hype_comms_server", "bootstrap-highwater-persisted", 0]],
  ["disconnect-replay", ["wake_broker", "disconnect-replay-reconciled", 1]],
  ["cursor-expiry", ["hype_comms_server", "cursor-expiry-entered-repair", 0]],
  ["server-reset", ["hype_comms_server", "server-reset-entered-repair", 0]],
  ["token-revocation", ["hype_comms_server", "revocation-entered-repair", 0]],
  ["enqueue-before-source-ack", ["wake_broker", "enqueue-preceded-source-ack", 1]],
  ["crash-before-target", ["host_process", "crash-before-target-recovered", 0]],
  ["crash-after-possible-target", ["host_process", "possible-target-entered-repair", null]],
  ["fifo-ordering", ["wake_broker", "fifo-order-preserved", 2]],
  ["capacity-pause", ["wake_broker", "capacity-paused-at-bound", 0]],
  ["provider-retry-exhaustion", ["wake_broker", "provider-retries-exhausted", null]],
  ["completion-ledger-bound", ["wake_broker", "completion-ledger-bound-held", 0]],
  ["provider-ledger-bound", ["wake_broker", "provider-ledger-bound-held", 0]],
  ["fresh-auth-start", ["hype_comms_server", "fresh-auth-gated-start", 0]],
  ["fresh-auth-resume", ["hype_comms_server", "fresh-auth-gated-resume", 0]],
  ["completion-store-recovery", ["wake_broker", "completion-store-entered-repair", 1]],
  ["source-disconnect-reconnect-01", ["wake_broker", "source-reconnect-completed", 0]],
  ["source-disconnect-reconnect-02", ["wake_broker", "source-reconnect-completed", 0]],
  ["source-disconnect-reconnect-03", ["wake_broker", "source-reconnect-completed", 0]],
  ["source-disconnect-reconnect-04", ["wake_broker", "source-reconnect-completed", 0]],
  ["desktop-restart-01", ["host_process", "desktop-restart-recovered", 0]],
  ["desktop-restart-02", ["host_process", "desktop-restart-recovered", 0]],
  ["shutdown-child-reaping", ["host_process", "zero-children-after-five-seconds", 0]],
  ["operator-status", ["operator_audit", "operator-status-observed", 0]],
  ["operator-confirm-accepted", ["operator_audit", "operator-confirmed-accepted", 0]],
  ["operator-confirm-duplicate", ["operator_audit", "operator-confirmed-duplicate", 0]],
  ["operator-confirm-coalesced", ["operator_audit", "operator-confirmed-coalesced", 0]],
  ["operator-provider-retry", ["operator_audit", "operator-authorized-provider-retry", 1]],
  ["operator-source-reset-from-now", ["operator_audit", "operator-reset-source-from-now", 0]],
  ["operator-resume", ["operator_audit", "operator-resumed-enrollment", 0]],
  ["executable-source-symlink-rejected", ["host_process", "source-symlink-rejected", 0]],
  ["executable-target-symlink-rejected", ["host_process", "target-symlink-rejected", 0]],
  ["executable-nonregular-rejected", ["host_process", "nonregular-leaf-rejected", 0]],
  ["executable-owner-rejected", ["host_process", "unexpected-owner-rejected", 0]],
  ["executable-mode-rejected", ["host_process", "unsafe-mode-rejected", 0]],
  ["executable-path-replacement-rejected", ["host_process", "path-replacement-rejected", 0]],
  ["executable-ancestor-symlink-rejected", ["host_process", "ancestor-symlink-rejected", 0]],
  ["executable-ancestor-mode-rejected", ["host_process", "unsafe-ancestor-mode-rejected", 0]],
  ["executable-runtime-hash-rejected", ["host_process", "runtime-hash-mismatch-rejected", 0]],
  ["executable-entrypoint-hash-rejected", ["host_process", "entrypoint-hash-mismatch-rejected", 0]],
  ["executable-target-hash-rejected", ["host_process", "target-hash-mismatch-rejected", 0]],
  ["executable-target-script-rejected", ["host_process", "target-script-rejected", 0]],
  [
    "executable-target-unknown-load-command-rejected",
    ["host_process", "target-unknown-load-command-rejected", 0],
  ],
  ["executable-path-lookup-ignored", ["host_process", "path-and-node-options-ignored", 0]],
  ["executable-root-owned-deployment", ["host_process", "runtime-entrypoint-target-root-owned", 0]],
  ["executable-native-arm64", ["host_process", "runtime-target-thin-arm64-mh-execute", 0]],
  ["cli-bundle-self-contained", ["macos_package", "cli-bundle-builtin-imports-only", 0]],
  ["runtime-signature", ["macos_codesign", "runtime-signature-valid", 0]],
  ["target-signature", ["macos_codesign", "target-signature-valid", 0]],
  ["host-election-single-active", ["host_process", "single-host-elected", 0]],
  [
    "host-controlled-failover",
    ["host_process", "former-host-and-children-stopped-before-failover", 0],
  ],
  ["packaged-operator-interface", ["macos_package", "packaged-operator-interface-passed", 0]],
  ["package-production-gate", ["macos_package", "production-gate-enabled", 0]],
  ["package-updater-isolated", ["macos_package", "package-updater-disabled", 0]],
  ["package-signature", ["macos_codesign", "package-signature-valid", 0]],
  ["package-notarization", ["apple_notary", "package-notarization-valid", 0]],
  ["package-install", ["macos_package", "installed-package-launched", 0]],
]);

const expectedRepairCodes = new Map([
  ["cursor-expiry", "source-cursor-expired"],
  ["server-reset", "source-server-reset"],
  ["token-revocation", "source-authentication-required"],
  ["crash-after-possible-target", "provider-outcome-ambiguous"],
  ["completion-store-recovery", "provider-outcome-ambiguous"],
  ["operator-confirm-accepted", "provider-outcome-ambiguous"],
  ["operator-confirm-duplicate", "provider-outcome-ambiguous"],
  ["operator-confirm-coalesced", "provider-outcome-ambiguous"],
  ["operator-provider-retry", "provider-outcome-ambiguous"],
  ["operator-source-reset-from-now", "source-cursor-expired"],
]);

const requiredSoakCaseIds = [
  "source-disconnect-reconnect-01",
  "source-disconnect-reconnect-02",
  "source-disconnect-reconnect-03",
  "source-disconnect-reconnect-04",
  "desktop-restart-01",
  "desktop-restart-02",
  "crash-before-target",
  "crash-after-possible-target",
  "completion-store-recovery",
  "operator-confirm-accepted",
];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const cursorPattern = /^(0|[1-9][0-9]*)$/u;
const safeOpaquePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const safeRepairPattern = /^[a-z][a-z0-9-]{0,127}$/u;

export class AgentWakeEvidenceManifestError extends Error {
  constructor(code, lineNumber = null) {
    super(
      lineNumber === null
        ? `Agent Wake evidence manifest validation failed: ${code}`
        : `Agent Wake evidence manifest validation failed at line ${lineNumber}: ${code}`,
    );
    this.name = "AgentWakeEvidenceManifestError";
    this.code = code;
    this.lineNumber = lineNumber;
  }
}

function fail(code, lineNumber = null) {
  throw new AgentWakeEvidenceManifestError(code, lineNumber);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value) {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
  );
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function isCanonicalIsoUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNullableCanonicalIsoUtc(value) {
  return value === null || isCanonicalIsoUtc(value);
}

function isSafeOpaque(value) {
  return typeof value === "string" && safeOpaquePattern.test(value);
}

function isNullableSafeOpaque(value) {
  return value === null || isSafeOpaque(value);
}

function isNullableUuid(value) {
  return value === null || (typeof value === "string" && uuidPattern.test(value));
}

function isNullableHash(value) {
  return value === null || (typeof value === "string" && hashPattern.test(value));
}

function isNullablePositiveInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}

function isNullableNonnegativeInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function authorityFieldsValid(value) {
  return (
    authorityKinds.has(value.authorityKind) &&
    isSafeOpaque(value.authorityId) &&
    isSafeOpaque(value.observationId) &&
    isCanonicalIsoUtc(value.observedAt)
  );
}

function normalizedHostTimestamp(value, clockSkewMs) {
  return Date.parse(value) - clockSkewMs;
}

function normalizedRecordedAt(record) {
  return normalizedHostTimestamp(record.recordedAt, record.clockSkewMs);
}

function validateAcceptedEvidence(record, lineNumber) {
  const evidence = record.caseEvidence;
  requireCondition(
    hasExactKeys(evidence, [
      "authorityId",
      "authorityKind",
      "fetchAgentUserId",
      "fetchClient",
      "fetchCommand",
      "fetchEvidenceId",
      "fetchObservedAt",
      "fetchResultCount",
      "fetchedMessageId",
      "historyRequestCount",
      "observationId",
      "observedAt",
      "pollAutomationId",
      "pollExecutionCountSinceDisable",
      "pollJobId",
      "pollSourceAuditId",
      "pollSystemId",
      "targetActivationCount",
      "type",
      "wakeSource",
    ]),
    "accepted-evidence-fields-invalid",
    lineNumber,
  );
  requireCondition(evidence.type === "accepted_wake", "accepted-evidence-type-invalid", lineNumber);
  requireCondition(
    authorityFieldsValid(evidence),
    "accepted-evidence-authority-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.authorityKind === "provider_cli_correlation",
    "accepted-evidence-authority-kind-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.fetchClient === "hype-comms-cli",
    "accepted-fetch-client-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.fetchCommand === "messages.get",
    "accepted-fetch-command-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.fetchEvidenceId === record.exactMessageFetchEvidenceId,
    "accepted-fetch-evidence-id-mismatch",
    lineNumber,
  );
  requireCondition(
    evidence.fetchedMessageId === record.messageId,
    "accepted-fetch-message-mismatch",
    lineNumber,
  );
  requireCondition(
    evidence.fetchAgentUserId === record.agentUserId,
    "accepted-fetch-agent-mismatch",
    lineNumber,
  );
  requireCondition(
    isCanonicalIsoUtc(evidence.fetchObservedAt),
    "accepted-fetch-observed-at-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.fetchResultCount === 1,
    "accepted-fetch-result-count-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.historyRequestCount === 0,
    "accepted-history-request-count-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.targetActivationCount === 1,
    "accepted-activation-count-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.wakeSource === "event_push",
    "accepted-wake-source-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.observedAt === record.recordedAt,
    "accepted-evidence-observed-at-mismatch",
    lineNumber,
  );

  const isPostPollWake =
    record.caseId === "poll-push-only-dm" || record.caseId === "poll-push-only-mention";
  for (const field of ["pollSystemId", "pollAutomationId", "pollJobId", "pollSourceAuditId"]) {
    requireCondition(
      isPostPollWake ? isSafeOpaque(evidence[field]) : evidence[field] === null,
      `accepted-${field}-invalid`,
      lineNumber,
    );
  }
  requireCondition(
    isPostPollWake
      ? evidence.pollExecutionCountSinceDisable === 0
      : evidence.pollExecutionCountSinceDisable === null,
    "accepted-poll-execution-count-invalid",
    lineNumber,
  );
}

function validateSuppressedEvidence(record, lineNumber) {
  const evidence = record.caseEvidence;
  requireCondition(
    hasExactKeys(evidence, [
      "authorityId",
      "authorityKind",
      "checkpointCursor",
      "checkpointDurableAt",
      "observationId",
      "observedAt",
      "targetInvocationCount",
      "type",
    ]),
    "suppressed-evidence-fields-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.type === "suppressed_event",
    "suppressed-evidence-type-invalid",
    lineNumber,
  );
  requireCondition(
    authorityFieldsValid(evidence),
    "suppressed-evidence-authority-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.authorityKind === "wake_broker",
    "suppressed-authority-kind-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.checkpointCursor === record.sourceCursor,
    "suppressed-checkpoint-mismatch",
    lineNumber,
  );
  requireCondition(
    isCanonicalIsoUtc(evidence.checkpointDurableAt),
    "suppressed-checkpoint-at-invalid",
    lineNumber,
  );
  requireCondition(evidence.targetInvocationCount === 0, "suppressed-target-invoked", lineNumber);
  requireCondition(
    evidence.observedAt === record.recordedAt,
    "suppressed-observed-at-mismatch",
    lineNumber,
  );
  requireCondition(
    normalizedHostTimestamp(evidence.checkpointDurableAt, record.clockSkewMs) <=
      normalizedHostTimestamp(record.recordedAt, record.clockSkewMs),
    "suppressed-checkpoint-after-record",
    lineNumber,
  );
  if (record.messageCommittedAt !== null) {
    requireCondition(
      normalizedHostTimestamp(evidence.checkpointDurableAt, record.clockSkewMs) >=
        Date.parse(record.messageCommittedAt),
      "suppressed-checkpoint-before-message",
      lineNumber,
    );
  }
}

function validateReplayEvidence(record, lineNumber) {
  const evidence = record.caseEvidence;
  requireCondition(
    hasExactKeys(evidence, [
      "authorityId",
      "authorityKind",
      "observationId",
      "observedAt",
      "originalProviderActivityId",
      "targetInvocationCount",
      "type",
    ]),
    "replay-evidence-fields-invalid",
    lineNumber,
  );
  requireCondition(evidence.type === "dedupe_replay", "replay-evidence-type-invalid", lineNumber);
  requireCondition(authorityFieldsValid(evidence), "replay-evidence-authority-invalid", lineNumber);
  requireCondition(
    evidence.authorityKind === "wake_broker",
    "replay-authority-kind-invalid",
    lineNumber,
  );
  requireCondition(
    isSafeOpaque(evidence.originalProviderActivityId),
    "replay-original-activity-invalid",
    lineNumber,
  );
  requireCondition(evidence.targetInvocationCount === 0, "replay-target-invoked", lineNumber);
  requireCondition(
    evidence.observedAt === record.recordedAt,
    "replay-observed-at-mismatch",
    lineNumber,
  );
}

function validateSecurityEvidence(record, lineNumber) {
  const evidence = record.caseEvidence;
  requireCondition(
    hasExactKeys(evidence, [
      "agentTokenMatches",
      "authorityId",
      "authorityKind",
      "childOutputMatches",
      "credentialHandleMatches",
      "historyMatches",
      "messageBodyMatches",
      "observationId",
      "observedAt",
      "promptMatches",
      "providerCredentialMatches",
      "surface",
      "type",
    ]),
    "security-evidence-fields-invalid",
    lineNumber,
  );
  requireCondition(evidence.type === "security_scan", "security-evidence-type-invalid", lineNumber);
  requireCondition(
    authorityFieldsValid(evidence),
    "security-evidence-authority-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.authorityKind === "independent_security_review",
    "security-authority-kind-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.surface === securitySurfaces.get(record.caseId),
    "security-surface-invalid",
    lineNumber,
  );
  for (const field of [
    "agentTokenMatches",
    "childOutputMatches",
    "credentialHandleMatches",
    "historyMatches",
    "messageBodyMatches",
    "promptMatches",
    "providerCredentialMatches",
  ]) {
    requireCondition(evidence[field] === 0, `security-${field}-nonzero`, lineNumber);
  }
  requireCondition(
    evidence.observedAt === record.recordedAt,
    "security-observed-at-mismatch",
    lineNumber,
  );
}

function validateCaseObservation(record, lineNumber) {
  const evidence = record.caseEvidence;
  requireCondition(
    hasExactKeys(evidence, [
      "authorityId",
      "authorityKind",
      "inducedAt",
      "observationId",
      "observedAt",
      "outcome",
      "targetInvocationCount",
      "type",
    ]),
    "case-evidence-fields-invalid",
    lineNumber,
  );
  requireCondition(evidence.type === "case_observation", "case-evidence-type-invalid", lineNumber);
  requireCondition(authorityFieldsValid(evidence), "case-evidence-authority-invalid", lineNumber);
  requireCondition(evidence.inducedAt !== null, "case-induced-at-missing", lineNumber);
  requireCondition(isCanonicalIsoUtc(evidence.inducedAt), "case-induced-at-invalid", lineNumber);
  requireCondition(
    isNullableNonnegativeInteger(evidence.targetInvocationCount),
    "case-target-invocation-count-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.observedAt === record.recordedAt,
    "case-observed-at-mismatch",
    lineNumber,
  );
  requireCondition(
    Date.parse(evidence.inducedAt) <= Date.parse(evidence.observedAt),
    "case-observed-before-induced",
    lineNumber,
  );
  const requirement = caseObservationRequirements.get(record.caseId);
  requireCondition(requirement !== undefined, "case-evidence-requirement-missing", lineNumber);
  const [authorityKind, outcome, targetInvocationCount] = requirement;
  requireCondition(
    evidence.authorityKind === authorityKind,
    "case-authority-kind-mismatch",
    lineNumber,
  );
  requireCondition(evidence.outcome === outcome, "case-outcome-mismatch", lineNumber);
  requireCondition(
    evidence.targetInvocationCount === targetInvocationCount,
    "case-target-invocation-count-mismatch",
    lineNumber,
  );
  if (record.caseId === "token-revocation") {
    requireCondition(
      Date.parse(evidence.observedAt) - Date.parse(evidence.inducedAt) <= 60_000,
      "revocation-repair-too-late",
      lineNumber,
    );
  }
}

function validateSoakHeartbeatEvidence(record, lineNumber) {
  const evidence = record.caseEvidence;
  requireCondition(
    hasExactKeys(evidence, [
      "authorityId",
      "authorityKind",
      "brokerState",
      "completionLedgerSize",
      "observationId",
      "observedAt",
      "providerLedgerSize",
      "queueDepth",
      "repairCode",
      "soakRunId",
      "type",
    ]),
    "soak-heartbeat-evidence-fields-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.type === "soak_heartbeat",
    "soak-heartbeat-evidence-type-invalid",
    lineNumber,
  );
  requireCondition(authorityFieldsValid(evidence), "soak-heartbeat-authority-invalid", lineNumber);
  requireCondition(
    evidence.authorityKind === "wake_broker",
    "soak-heartbeat-authority-kind-invalid",
    lineNumber,
  );
  requireCondition(isSafeOpaque(evidence.soakRunId), "soak-run-id-invalid", lineNumber);
  requireCondition(evidence.brokerState === "running", "soak-broker-not-running", lineNumber);
  requireCondition(
    Number.isSafeInteger(evidence.queueDepth) &&
      evidence.queueDepth >= 0 &&
      evidence.queueDepth <= 100,
    "soak-queue-depth-invalid",
    lineNumber,
  );
  requireCondition(
    Number.isSafeInteger(evidence.completionLedgerSize) &&
      evidence.completionLedgerSize >= 0 &&
      evidence.completionLedgerSize <= 2_048,
    "soak-completion-ledger-size-invalid",
    lineNumber,
  );
  requireCondition(
    Number.isSafeInteger(evidence.providerLedgerSize) &&
      evidence.providerLedgerSize >= 0 &&
      evidence.providerLedgerSize <= 2_048,
    "soak-provider-ledger-size-invalid",
    lineNumber,
  );
  requireCondition(evidence.repairCode === null, "soak-heartbeat-has-repair", lineNumber);
  requireCondition(
    evidence.observedAt === record.recordedAt,
    "soak-heartbeat-at-mismatch",
    lineNumber,
  );
}

function validateSoakSummaryEvidence(record, lineNumber) {
  const evidence = record.caseEvidence;
  requireCondition(
    hasExactKeys(evidence, [
      "authorityId",
      "authorityKind",
      "childrenAliveAfterShutdown",
      "duplicateActivationCount",
      "eligibleWakeCount",
      "finalRepairCode",
      "lostEligibleWakeCount",
      "maximumCompletionLedgerSize",
      "maximumProviderLedgerSize",
      "maximumQueueDepth",
      "observationId",
      "observedAt",
      "soakCompletedAt",
      "soakRunId",
      "soakStartedAt",
      "targetActivationCount",
      "type",
    ]),
    "soak-summary-evidence-fields-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.type === "soak_summary",
    "soak-summary-evidence-type-invalid",
    lineNumber,
  );
  requireCondition(authorityFieldsValid(evidence), "soak-summary-authority-invalid", lineNumber);
  requireCondition(
    evidence.authorityKind === "wake_broker",
    "soak-summary-authority-kind-invalid",
    lineNumber,
  );
  requireCondition(isSafeOpaque(evidence.soakRunId), "soak-run-id-invalid", lineNumber);
  requireCondition(
    isCanonicalIsoUtc(evidence.soakStartedAt),
    "soak-started-at-invalid",
    lineNumber,
  );
  requireCondition(
    isCanonicalIsoUtc(evidence.soakCompletedAt),
    "soak-completed-at-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.soakCompletedAt === record.recordedAt,
    "soak-completed-at-mismatch",
    lineNumber,
  );
  requireCondition(
    evidence.observedAt === record.recordedAt,
    "soak-summary-observed-at-mismatch",
    lineNumber,
  );
  for (const [field, maximum] of [
    ["maximumQueueDepth", 100],
    ["maximumCompletionLedgerSize", 2_048],
    ["maximumProviderLedgerSize", 2_048],
  ]) {
    requireCondition(
      Number.isSafeInteger(evidence[field]) && evidence[field] >= 0 && evidence[field] <= maximum,
      `soak-summary-${field}-invalid`,
      lineNumber,
    );
  }
  requireCondition(
    Number.isSafeInteger(evidence.eligibleWakeCount) && evidence.eligibleWakeCount >= 30,
    "soak-summary-eligible-count-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.targetActivationCount === evidence.eligibleWakeCount,
    "soak-summary-activation-count-invalid",
    lineNumber,
  );
  requireCondition(evidence.lostEligibleWakeCount === 0, "soak-summary-lost-wakes", lineNumber);
  requireCondition(
    evidence.duplicateActivationCount === 0,
    "soak-summary-duplicate-activations",
    lineNumber,
  );
  requireCondition(evidence.finalRepairCode === null, "soak-summary-has-repair", lineNumber);
  requireCondition(
    evidence.childrenAliveAfterShutdown === 0,
    "soak-summary-live-children",
    lineNumber,
  );
}

const pollIdentityFields = [
  "pollAutomationId",
  "pollJobId",
  "pollOwnerId",
  "pollSchedule",
  "pollSystemId",
];

function validatePollIdentity(evidence, lineNumber) {
  for (const field of ["pollAutomationId", "pollJobId", "pollOwnerId", "pollSystemId"]) {
    requireCondition(isSafeOpaque(evidence[field]), `poll-${field}-invalid`, lineNumber);
  }
  requireCondition(evidence.pollSchedule === "PT15M", "poll-schedule-invalid", lineNumber);
}

function validatePollEvidence(record, lineNumber) {
  const evidence = record.caseEvidence;
  const common = [
    "authorityId",
    "authorityKind",
    "observationId",
    "observedAt",
    ...pollIdentityFields,
    "type",
  ];
  requireCondition(isPlainObject(evidence), "poll-evidence-not-object", lineNumber);
  requireCondition(authorityFieldsValid(evidence), "poll-evidence-authority-invalid", lineNumber);
  requireCondition(
    evidence.authorityKind === "scheduler",
    "poll-authority-kind-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.observedAt === record.recordedAt,
    "poll-observed-at-mismatch",
    lineNumber,
  );
  validatePollIdentity(evidence, lineNumber);

  if (record.caseId === "poll-inventory") {
    requireCondition(
      hasExactKeys(evidence, [...common, "enabled", "lastSuccessfulRunAt"]),
      "poll-inventory-fields-invalid",
      lineNumber,
    );
    requireCondition(evidence.type === "poll_inventory", "poll-inventory-type-invalid", lineNumber);
    requireCondition(evidence.enabled === true, "poll-inventory-not-enabled", lineNumber);
    requireCondition(
      isCanonicalIsoUtc(evidence.lastSuccessfulRunAt) &&
        Date.parse(evidence.lastSuccessfulRunAt) <= Date.parse(evidence.observedAt),
      "poll-last-success-invalid",
      lineNumber,
    );
    return;
  }
  if (record.caseId === "poll-disabled") {
    requireCondition(
      hasExactKeys(evidence, [...common, "approvedChangeId", "disabledAt", "schedulerAuditId"]),
      "poll-disabled-fields-invalid",
      lineNumber,
    );
    requireCondition(evidence.type === "poll_disabled", "poll-disabled-type-invalid", lineNumber);
    requireCondition(isSafeOpaque(evidence.approvedChangeId), "poll-change-id-invalid", lineNumber);
    requireCondition(
      isSafeOpaque(evidence.schedulerAuditId),
      "poll-disable-audit-id-invalid",
      lineNumber,
    );
    requireCondition(
      evidence.disabledAt === record.recordedAt,
      "poll-disabled-at-mismatch",
      lineNumber,
    );
    return;
  }
  if (record.caseId === "poll-interval-01-zero" || record.caseId === "poll-interval-02-zero") {
    requireCondition(
      hasExactKeys(evidence, [
        ...common,
        "executionCount",
        "schedulerAuditId",
        "windowEndedAt",
        "windowIndex",
        "windowStartedAt",
      ]),
      "poll-window-fields-invalid",
      lineNumber,
    );
    requireCondition(
      evidence.type === "poll_zero_execution_window",
      "poll-window-type-invalid",
      lineNumber,
    );
    requireCondition(
      evidence.windowIndex === (record.caseId === "poll-interval-01-zero" ? 1 : 2),
      "poll-window-index-invalid",
      lineNumber,
    );
    requireCondition(
      isCanonicalIsoUtc(evidence.windowStartedAt),
      "poll-window-start-invalid",
      lineNumber,
    );
    requireCondition(
      isCanonicalIsoUtc(evidence.windowEndedAt),
      "poll-window-end-invalid",
      lineNumber,
    );
    requireCondition(
      evidence.executionCount === 0,
      "poll-window-execution-count-nonzero",
      lineNumber,
    );
    requireCondition(
      isSafeOpaque(evidence.schedulerAuditId),
      "poll-window-audit-id-invalid",
      lineNumber,
    );
    requireCondition(
      Date.parse(evidence.observedAt) >= Date.parse(evidence.windowEndedAt),
      "poll-window-observed-before-end",
      lineNumber,
    );
    return;
  }
  requireCondition(
    record.caseId === "poll-two-intervals-zero",
    "poll-evidence-case-invalid",
    lineNumber,
  );
  requireCondition(
    hasExactKeys(evidence, [
      ...common,
      "executionCount",
      "observationEndedAt",
      "observationStartedAt",
      "schedulerAuditId",
    ]),
    "poll-summary-fields-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.type === "poll_zero_execution_summary",
    "poll-summary-type-invalid",
    lineNumber,
  );
  requireCondition(
    isCanonicalIsoUtc(evidence.observationStartedAt),
    "poll-summary-start-invalid",
    lineNumber,
  );
  requireCondition(
    isCanonicalIsoUtc(evidence.observationEndedAt),
    "poll-summary-end-invalid",
    lineNumber,
  );
  requireCondition(
    evidence.executionCount === 0,
    "poll-summary-execution-count-nonzero",
    lineNumber,
  );
  requireCondition(
    isSafeOpaque(evidence.schedulerAuditId),
    "poll-summary-audit-id-invalid",
    lineNumber,
  );
  requireCondition(
    Date.parse(evidence.observedAt) >= Date.parse(evidence.observationEndedAt),
    "poll-summary-observed-before-end",
    lineNumber,
  );
}

function requireCondition(condition, code, lineNumber) {
  if (!condition) fail(code, lineNumber);
}

function wakeIdFor(record) {
  return createHash("sha256")
    .update(
      JSON.stringify(["hype-wake-v1", record.workspaceId, record.agentUserId, record.messageId]),
      "utf8",
    )
    .digest("hex");
}

function validateRecord(record, lineNumber) {
  requireCondition(isPlainObject(record), "record-not-object", lineNumber);
  requireCondition(exactKeys(record), "record-fields-invalid", lineNumber);
  requireCondition(record.version === 1, "version-invalid", lineNumber);
  requireCondition(record.type === "agent.wake.rollout_evidence", "type-invalid", lineNumber);
  requireCondition(isCanonicalIsoUtc(record.recordedAt), "recorded-at-invalid", lineNumber);
  requireCondition(
    typeof record.runId === "string" && uuidPattern.test(record.runId),
    "run-id-invalid",
    lineNumber,
  );
  requireCondition(isSafeOpaque(record.caseId), "case-id-invalid", lineNumber);
  requireCondition(scenarios.has(record.scenario), "scenario-invalid", lineNumber);
  requireCondition(
    record.result === "pass" || record.result === "fail",
    "result-invalid",
    lineNumber,
  );
  requireCondition(
    typeof record.gitCommit === "string" && commitPattern.test(record.gitCommit),
    "git-commit-invalid",
    lineNumber,
  );
  requireCondition(
    typeof record.appVersion === "string" && validSemver(record.appVersion) === record.appVersion,
    "app-version-invalid",
    lineNumber,
  );
  requireCondition(record.buildFlavor === "production", "build-flavor-invalid", lineNumber);
  requireCondition(record.platform === "darwin", "platform-invalid", lineNumber);
  requireCondition(record.architecture === "arm64", "architecture-invalid", lineNumber);
  requireCondition(
    Number.isInteger(record.clockSkewMs) && Math.abs(record.clockSkewMs) <= 100,
    "clock-skew-invalid",
    lineNumber,
  );
  requireCondition(isSafeOpaque(record.wakeHostId), "wake-host-id-invalid", lineNumber);
  requireCondition(isSafeOpaque(record.enrollmentId), "enrollment-id-invalid", lineNumber);
  requireCondition(isSafeOpaque(record.agentIdentityLabel), "agent-label-invalid", lineNumber);
  requireCondition(
    !placeholderAgentLabels.has(record.agentIdentityLabel.toLowerCase()) &&
      !desktopSliceAgentLabelPattern.test(record.agentIdentityLabel),
    "agent-label-placeholder",
    lineNumber,
  );
  requireCondition(record.targetKind === "grok_bot", "target-kind-invalid", lineNumber);
  requireCondition(
    isSafeOpaque(record.targetBotId) &&
      !placeholderAgentLabels.has(record.targetBotId.toLowerCase()) &&
      !desktopSliceAgentLabelPattern.test(record.targetBotId),
    "target-bot-id-invalid",
    lineNumber,
  );
  requireCondition(
    isSafeOpaque(record.targetIdentityAuthorityId),
    "target-identity-authority-id-invalid",
    lineNumber,
  );
  requireCondition(isPlainObject(record.caseEvidence), "case-evidence-not-object", lineNumber);
  requireCondition(isSafeOpaque(record.adapterId), "adapter-id-invalid", lineNumber);
  requireCondition(
    typeof record.workspaceId === "string" && uuidPattern.test(record.workspaceId),
    "workspace-id-invalid",
    lineNumber,
  );
  requireCondition(
    typeof record.agentUserId === "string" && uuidPattern.test(record.agentUserId),
    "agent-user-id-invalid",
    lineNumber,
  );
  requireCondition(isNullableUuid(record.conversationId), "conversation-id-invalid", lineNumber);
  requireCondition(isNullableUuid(record.messageId), "message-id-invalid", lineNumber);
  requireCondition(isNullableHash(record.wakeId), "wake-id-invalid", lineNumber);
  requireCondition(
    record.reason === null || reasons.has(record.reason),
    "reason-invalid",
    lineNumber,
  );
  requireCondition(
    typeof record.sourceCursor === "string" && cursorPattern.test(record.sourceCursor),
    "source-cursor-invalid",
    lineNumber,
  );
  requireCondition(isNullablePositiveInteger(record.attempt), "attempt-invalid", lineNumber);
  requireCondition(
    isNullableCanonicalIsoUtc(record.messageCommittedAt),
    "message-committed-at-invalid",
    lineNumber,
  );
  requireCondition(
    isNullableCanonicalIsoUtc(record.brokerDurableAt),
    "broker-durable-at-invalid",
    lineNumber,
  );
  requireCondition(
    isNullableCanonicalIsoUtc(record.providerAcceptedAt),
    "provider-accepted-at-invalid",
    lineNumber,
  );
  requireCondition(isNullableNonnegativeInteger(record.latencyMs), "latency-invalid", lineNumber);
  requireCondition(
    receiptKinds.has(record.providerReceiptKind),
    "receipt-kind-invalid",
    lineNumber,
  );
  requireCondition(
    isNullableSafeOpaque(record.providerReceiptId),
    "receipt-id-invalid",
    lineNumber,
  );
  requireCondition(
    isNullableSafeOpaque(record.providerActivityId),
    "provider-activity-id-invalid",
    lineNumber,
  );
  requireCondition(
    isNullableCanonicalIsoUtc(record.providerActivityObservedAt),
    "provider-activity-at-invalid",
    lineNumber,
  );
  requireCondition(
    isNullableSafeOpaque(record.exactMessageFetchEvidenceId),
    "exact-fetch-id-invalid",
    lineNumber,
  );
  requireCondition(
    record.repairCode === null ||
      (typeof record.repairCode === "string" && safeRepairPattern.test(record.repairCode)),
    "repair-code-invalid",
    lineNumber,
  );
  requireCondition(
    record.operatorAction === null || operatorActions.has(record.operatorAction),
    "operator-action-invalid",
    lineNumber,
  );
  requireCondition(
    isSafeOpaque(record.evidenceReference),
    "evidence-reference-invalid",
    lineNumber,
  );
  requireCondition(
    typeof record.evidenceDigestSha256 === "string" &&
      hashPattern.test(record.evidenceDigestSha256),
    "evidence-digest-invalid",
    lineNumber,
  );

  requireCondition(
    (record.providerReceiptKind === "none") === (record.providerReceiptId === null),
    "receipt-kind-id-mismatch",
    lineNumber,
  );
  requireCondition(
    (record.providerActivityId === null) === (record.providerActivityObservedAt === null),
    "provider-activity-incomplete",
    lineNumber,
  );
  if (record.wakeId !== null) {
    requireCondition(record.messageId !== null, "wake-without-message", lineNumber);
    requireCondition(record.wakeId === wakeIdFor(record), "wake-id-mismatch", lineNumber);
  }
}

function isAcceptedRecord(record) {
  return (
    record.scenario === "direct_message" ||
    record.scenario === "verified_mention" ||
    record.caseId === "poll-push-only-dm" ||
    record.caseId === "poll-push-only-mention"
  );
}

function validateAcceptedRecord(record, lineNumber) {
  const required = [
    "conversationId",
    "messageId",
    "wakeId",
    "reason",
    "attempt",
    "messageCommittedAt",
    "brokerDurableAt",
    "providerAcceptedAt",
    "latencyMs",
    "providerReceiptId",
    "providerActivityId",
    "providerActivityObservedAt",
    "exactMessageFetchEvidenceId",
  ];
  for (const field of required) {
    requireCondition(record[field] !== null, `accepted-${field}-missing`, lineNumber);
  }
  requireCondition(
    record.providerReceiptKind === "provider_issued",
    "accepted-receipt-not-authoritative",
    lineNumber,
  );
  requireCondition(record.repairCode === null, "accepted-has-repair", lineNumber);
  requireCondition(record.operatorAction === null, "accepted-has-operator-action", lineNumber);
  validateAcceptedEvidence(record, lineNumber);

  const expectedReason =
    record.scenario === "direct_message" || record.caseId === "poll-push-only-dm"
      ? "direct_message"
      : "verified_mention";
  requireCondition(record.reason === expectedReason, "accepted-reason-mismatch", lineNumber);

  const committedAt = Date.parse(record.messageCommittedAt);
  const durableAt = normalizedHostTimestamp(record.brokerDurableAt, record.clockSkewMs);
  const acceptedAt = normalizedHostTimestamp(record.providerAcceptedAt, record.clockSkewMs);
  const fetchAt = normalizedHostTimestamp(record.caseEvidence.fetchObservedAt, record.clockSkewMs);
  const activityAt = normalizedHostTimestamp(record.providerActivityObservedAt, record.clockSkewMs);
  requireCondition(durableAt >= committedAt, "accepted-durable-before-commit", lineNumber);
  requireCondition(acceptedAt >= durableAt, "accepted-before-durable", lineNumber);
  requireCondition(
    record.latencyMs === acceptedAt - committedAt,
    "accepted-latency-mismatch",
    lineNumber,
  );
  requireCondition(fetchAt >= acceptedAt, "fetch-before-acceptance", lineNumber);
  requireCondition(activityAt >= fetchAt, "activity-before-fetch", lineNumber);
  requireCondition(
    activityAt - acceptedAt <= FIVE_MINUTES_MS,
    "activity-observed-too-late",
    lineNumber,
  );
  requireCondition(
    normalizedHostTimestamp(record.recordedAt, record.clockSkewMs) >= activityAt,
    "recorded-before-activity",
    lineNumber,
  );
}

function validateSuppressedRecord(record, lineNumber) {
  const mustBeNull = [
    "wakeId",
    "reason",
    "attempt",
    "brokerDurableAt",
    "providerAcceptedAt",
    "latencyMs",
    "providerReceiptId",
    "providerActivityId",
    "providerActivityObservedAt",
    "exactMessageFetchEvidenceId",
    "repairCode",
    "operatorAction",
  ];
  for (const field of mustBeNull) {
    requireCondition(record[field] === null, `suppressed-${field}-present`, lineNumber);
  }
  requireCondition(record.providerReceiptKind === "none", "suppressed-receipt-kind", lineNumber);
  validateSuppressedEvidence(record, lineNumber);
}

function validateReplayRecord(record, lineNumber) {
  requireCondition(record.wakeId !== null, "replay-wake-id-missing", lineNumber);
  requireCondition(record.messageId !== null, "replay-message-id-missing", lineNumber);
  requireCondition(record.reason !== null, "replay-reason-missing", lineNumber);
  for (const field of [
    "attempt",
    "brokerDurableAt",
    "providerAcceptedAt",
    "latencyMs",
    "providerReceiptId",
    "providerActivityId",
    "providerActivityObservedAt",
    "exactMessageFetchEvidenceId",
    "repairCode",
    "operatorAction",
  ]) {
    requireCondition(record[field] === null, `replay-${field}-present`, lineNumber);
  }
  requireCondition(record.providerReceiptKind === "none", "replay-receipt-kind", lineNumber);
  validateReplayEvidence(record, lineNumber);
}

function requireWakePointer(record, lineNumber, prefix) {
  for (const field of [
    "conversationId",
    "messageId",
    "wakeId",
    "reason",
    "attempt",
    "messageCommittedAt",
    "brokerDurableAt",
  ]) {
    requireCondition(record[field] !== null, `${prefix}-${field}-missing`, lineNumber);
  }
}

function validateCaseSemantics(record, lineNumber) {
  if (isAcceptedRecord(record)) validateAcceptedRecord(record, lineNumber);
  if (record.scenario === "suppressed") validateSuppressedRecord(record, lineNumber);
  if (record.scenario === "replay") validateReplayRecord(record, lineNumber);
  if (record.scenario === "security") validateSecurityEvidence(record, lineNumber);
  if (
    record.scenario === "failure" ||
    record.scenario === "operator" ||
    record.scenario === "integrity"
  ) {
    validateCaseObservation(record, lineNumber);
  }
  if (record.scenario === "soak") {
    if (record.caseId === "soak-summary") validateSoakSummaryEvidence(record, lineNumber);
    else validateSoakHeartbeatEvidence(record, lineNumber);
  }
  if (
    record.scenario === "poll_retirement" &&
    record.caseId !== "poll-push-only-dm" &&
    record.caseId !== "poll-push-only-mention"
  ) {
    validatePollEvidence(record, lineNumber);
  }

  const expectedScenario = exactCases.get(record.caseId);
  if (expectedScenario !== undefined) {
    requireCondition(record.scenario === expectedScenario, "case-scenario-mismatch", lineNumber);
  }

  const expectedAction = expectedOperatorActions.get(record.caseId);
  if (expectedAction !== undefined) {
    requireCondition(
      record.operatorAction === expectedAction,
      "case-operator-action-mismatch",
      lineNumber,
    );
  } else if (record.caseId === "operator-status") {
    requireCondition(record.operatorAction === null, "operator-status-mutated", lineNumber);
  }

  const expectedRepairCode = expectedRepairCodes.get(record.caseId);
  if (expectedRepairCode !== undefined) {
    requireCondition(
      record.repairCode === expectedRepairCode,
      "repair-case-code-mismatch",
      lineNumber,
    );
  }
  if (record.caseId === "completion-store-recovery") {
    requireCondition(
      record.repairCode === "provider-outcome-ambiguous",
      "completion-repair-code-invalid",
      lineNumber,
    );
    requireWakePointer(record, lineNumber, "completion-recovery");
  }
  if (record.caseId === "crash-after-possible-target") {
    requireWakePointer(record, lineNumber, "post-target-crash");
  }
  if (
    record.caseId === "operator-confirm-accepted" ||
    record.caseId === "operator-confirm-duplicate" ||
    record.caseId === "operator-confirm-coalesced"
  ) {
    requireCondition(
      record.repairCode === "provider-outcome-ambiguous",
      "provider-operator-repair-code-invalid",
      lineNumber,
    );
    requireWakePointer(record, lineNumber, "provider-operator");
    requireCondition(
      record.providerReceiptKind === "provider_issued" &&
        record.providerReceiptId !== null &&
        record.providerActivityId !== null &&
        record.providerActivityObservedAt !== null,
      "provider-confirmation-not-authoritative",
      lineNumber,
    );
  }
  if (record.caseId === "operator-provider-retry") {
    requireCondition(
      record.repairCode === "provider-outcome-ambiguous",
      "provider-operator-repair-code-invalid",
      lineNumber,
    );
    requireWakePointer(record, lineNumber, "provider-operator");
  }
  if (record.caseId === "operator-source-reset-from-now") {
    requireCondition(
      record.repairCode === "source-cursor-expired",
      "source-reset-repair-code-invalid",
      lineNumber,
    );
  }
}

export function parseAgentWakeEvidenceManifest(text) {
  if (typeof text !== "string" || text.length === 0) fail("evidence-empty");
  if (text.startsWith("\uFEFF")) fail("evidence-bom-forbidden");
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) fail("evidence-empty");
  if (lines.length > MAX_RECORDS) fail("evidence-record-limit");

  return lines.map((line, index) => {
    const lineNumber = index + 1;
    if (line.length === 0) fail("blank-line", lineNumber);
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) fail("line-too-large", lineNumber);
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      fail("json-invalid", lineNumber);
    }
    if (line !== JSON.stringify(value)) fail("json-not-canonical", lineNumber);
    validateRecord(value, lineNumber);
    validateCaseSemantics(value, lineNumber);
    return value;
  });
}

function requireOne(recordsByCase, caseId) {
  const record = recordsByCase.get(caseId);
  if (record === undefined) fail(`required-case-missing:${caseId}`);
  return record;
}

function assertSingleValue(records, field) {
  const values = new Set(records.map((record) => record[field]));
  if (values.size !== 1) fail(`run-${field}-inconsistent`);
}

function assertUniqueAcceptedField(records, field) {
  const values = new Set();
  for (const record of records) {
    const value = record[field];
    if (values.has(value)) fail(`accepted-${field}-duplicate`);
    values.add(value);
  }
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

export function validateAgentWakeEvidenceRecords(records) {
  if (!Array.isArray(records) || records.length === 0) fail("evidence-empty");
  if (records.length > MAX_RECORDS) fail("evidence-record-limit");

  const recordsByCase = new Map();
  let priorRecordedAt = -Infinity;
  for (const [index, record] of records.entries()) {
    const lineNumber = index + 1;
    validateRecord(record, lineNumber);
    validateCaseSemantics(record, lineNumber);
    if (record.result !== "pass") fail("case-failed", lineNumber);
    if (recordsByCase.has(record.caseId)) fail("case-id-duplicate", lineNumber);
    recordsByCase.set(record.caseId, record);
    const recordedAt = normalizedRecordedAt(record);
    if (recordedAt < priorRecordedAt) fail("records-not-chronological", lineNumber);
    priorRecordedAt = recordedAt;
  }

  for (const field of [
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
  ]) {
    assertSingleValue(records, field);
  }

  for (const [caseId, expectedScenario] of exactCases) {
    const record = requireOne(recordsByCase, caseId);
    if (record.scenario !== expectedScenario) fail(`required-case-scenario:${caseId}`);
  }

  const observationIds = new Set();
  for (const record of records) {
    const observationId = record.caseEvidence.observationId;
    if (observationIds.has(observationId)) fail("authority-observation-id-duplicate");
    observationIds.add(observationId);
  }

  const directMessages = records.filter(
    (record) =>
      record.scenario === "direct_message" && /^latency-dm-[0-9]{3}$/u.test(record.caseId),
  );
  const verifiedMentions = records.filter(
    (record) =>
      record.scenario === "verified_mention" &&
      (/^latency-mention-[0-9]{3}$/u.test(record.caseId) ||
        record.caseId === "latency-mention-precedence"),
  );
  if (directMessages.length < 15) fail("direct-message-count-insufficient");
  if (verifiedMentions.length < 15) fail("verified-mention-count-insufficient");
  requireOne(recordsByCase, "latency-mention-precedence");

  const latencyRecords = [...directMessages, ...verifiedMentions];
  const p95LatencyMs = percentile95(latencyRecords.map((record) => record.latencyMs));
  const maximumLatencyMs = Math.max(...latencyRecords.map((record) => record.latencyMs));
  if (p95LatencyMs > 5_000) fail("latency-p95-exceeded");
  if (maximumLatencyMs > 30_000) fail("latency-maximum-exceeded");

  const acceptedRecords = records.filter(isAcceptedRecord);
  for (const field of [
    "wakeId",
    "messageId",
    "providerReceiptId",
    "providerActivityId",
    "exactMessageFetchEvidenceId",
  ]) {
    assertUniqueAcceptedField(acceptedRecords, field);
  }

  const sourceAdvanceRecords = records.filter(
    (record) => isAcceptedRecord(record) || record.scenario === "suppressed",
  );
  let priorSourceCursor = -1n;
  for (const record of sourceAdvanceRecords) {
    const sourceCursor = BigInt(record.sourceCursor);
    if (sourceCursor <= priorSourceCursor) fail("source-cursor-did-not-advance");
    priorSourceCursor = sourceCursor;
  }

  const replayRecords = records.filter(
    (record) => record.scenario === "replay" && /^duplicate-replay-[0-9]{3}$/u.test(record.caseId),
  );
  if (replayRecords.length < 100) fail("duplicate-replay-count-insufficient");
  const acceptedWakeIds = new Set(latencyRecords.map((record) => record.wakeId));
  const acceptedByWakeId = new Map(latencyRecords.map((record) => [record.wakeId, record]));
  for (const record of replayRecords) {
    if (!acceptedWakeIds.has(record.wakeId)) fail("replay-does-not-reference-accepted-wake");
    const original = acceptedByWakeId.get(record.wakeId);
    if (
      record.messageId !== original.messageId ||
      record.conversationId !== original.conversationId ||
      record.reason !== original.reason ||
      record.sourceCursor !== original.sourceCursor ||
      record.messageCommittedAt !== original.messageCommittedAt
    ) {
      fail("replay-original-pointer-mismatch");
    }
    if (record.caseEvidence.originalProviderActivityId !== original.providerActivityId) {
      fail("replay-original-activity-mismatch");
    }
    if (
      normalizedRecordedAt(record) <=
      normalizedHostTimestamp(original.providerActivityObservedAt, original.clockSkewMs)
    ) {
      fail("replay-before-original-activity");
    }
  }
  for (const caseId of [
    "operator-confirm-accepted",
    "operator-confirm-duplicate",
    "operator-confirm-coalesced",
  ]) {
    const record = requireOne(recordsByCase, caseId);
    const original = acceptedByWakeId.get(record.wakeId);
    if (
      original === undefined ||
      record.messageId !== original.messageId ||
      record.conversationId !== original.conversationId ||
      record.providerActivityId !== original.providerActivityId ||
      normalizedHostTimestamp(record.providerActivityObservedAt, record.clockSkewMs) <
        normalizedHostTimestamp(original.providerActivityObservedAt, original.clockSkewMs)
    ) {
      fail(`provider-confirmation-activity-mismatch:${caseId}`);
    }
  }

  const suppressedRecords = records.filter((record) => record.scenario === "suppressed");
  if (suppressedRecords.length < 1_000) fail("suppressed-count-insufficient");
  for (const category of suppressedCategories) {
    if (!suppressedRecords.some((record) => record.caseId.startsWith(`suppressed-${category}-`))) {
      fail(`suppressed-category-missing:${category}`);
    }
  }

  const hostIds = new Set(records.map((record) => record.wakeHostId));
  if (hostIds.size !== 2) fail("controlled-failover-host-count-invalid");
  const election = requireOne(recordsByCase, "host-election-single-active");
  const failover = requireOne(recordsByCase, "host-controlled-failover");
  if (election.wakeHostId === failover.wakeHostId) fail("controlled-failover-host-unchanged");
  if (normalizedRecordedAt(failover) <= normalizedRecordedAt(election)) {
    fail("controlled-failover-order-invalid");
  }
  const failoverAt = normalizedRecordedAt(failover);
  for (const record of records) {
    const expectedHost =
      normalizedRecordedAt(record) < failoverAt ? election.wakeHostId : failover.wakeHostId;
    if (record.wakeHostId !== expectedHost) fail("controlled-failover-host-overlap");
  }

  const soak = requireOne(recordsByCase, "soak-summary");
  const soakHeartbeats = records.filter(
    (record) => record.scenario === "soak" && /^soak-heartbeat-[0-9]{3}$/u.test(record.caseId),
  );
  if (soakHeartbeats.length < 97) fail("soak-heartbeat-count-insufficient");
  const firstAcceptedAt = Math.min(
    ...latencyRecords.map((record) => Date.parse(record.messageCommittedAt)),
  );
  const soakCompletedAt = normalizedRecordedAt(soak);
  if (Date.parse(soak.caseEvidence.soakStartedAt) !== firstAcceptedAt) {
    fail("soak-start-evidence-mismatch");
  }
  if (soakCompletedAt - firstAcceptedAt < TWENTY_FOUR_HOURS_MS) fail("soak-too-short");
  const heartbeatTimes = soakHeartbeats.map(normalizedRecordedAt);
  if (heartbeatTimes[0] < firstAcceptedAt || heartbeatTimes[0] - firstAcceptedAt > 60_000) {
    fail("soak-first-heartbeat-invalid");
  }
  for (let index = 1; index < heartbeatTimes.length; index += 1) {
    const gap = heartbeatTimes[index] - heartbeatTimes[index - 1];
    if (gap <= 0 || gap > SIXTEEN_MINUTES_MS) fail("soak-heartbeat-gap-invalid");
  }
  if (
    soakCompletedAt < heartbeatTimes.at(-1) ||
    soakCompletedAt - heartbeatTimes.at(-1) > SIXTEEN_MINUTES_MS
  ) {
    fail("soak-final-heartbeat-invalid");
  }
  for (const record of [
    ...latencyRecords,
    ...replayRecords,
    ...suppressedRecords,
    requireOne(recordsByCase, "source-disconnect-reconnect-04"),
    requireOne(recordsByCase, "desktop-restart-02"),
    requireOne(recordsByCase, "crash-before-target"),
    requireOne(recordsByCase, "crash-after-possible-target"),
    requireOne(recordsByCase, "completion-store-recovery"),
    ...requiredSoakCaseIds.map((caseId) => requireOne(recordsByCase, caseId)),
  ]) {
    const recordedAt = normalizedRecordedAt(record);
    if (recordedAt < firstAcceptedAt) fail("soak-case-recorded-before-start");
    if (recordedAt > soakCompletedAt) fail("soak-case-recorded-after-summary");
  }
  const soakEvidenceRecords = [soak, ...soakHeartbeats];
  const soakRunIds = new Set(soakEvidenceRecords.map((record) => record.caseEvidence.soakRunId));
  if (soakRunIds.size !== 1) fail("soak-run-id-inconsistent");
  const soakAcceptedRecords = acceptedRecords.filter(
    (record) =>
      Date.parse(record.messageCommittedAt) >= firstAcceptedAt &&
      normalizedRecordedAt(record) <= soakCompletedAt,
  );
  if (soak.caseEvidence.eligibleWakeCount !== soakAcceptedRecords.length) {
    fail("soak-summary-eligible-count-mismatch");
  }
  if (
    !soakAcceptedRecords.some((record) => record.wakeHostId === election.wakeHostId) ||
    !soakAcceptedRecords.some((record) => record.wakeHostId === failover.wakeHostId)
  ) {
    fail("controlled-failover-not-exercised");
  }

  const pollDisabled = requireOne(recordsByCase, "poll-disabled");
  const pollIntervalOne = requireOne(recordsByCase, "poll-interval-01-zero");
  const pollIntervalTwo = requireOne(recordsByCase, "poll-interval-02-zero");
  const pollObserved = requireOne(recordsByCase, "poll-two-intervals-zero");
  const pollDm = requireOne(recordsByCase, "poll-push-only-dm");
  const pollMention = requireOne(recordsByCase, "poll-push-only-mention");
  const pollInventory = requireOne(recordsByCase, "poll-inventory");
  if (normalizedRecordedAt(pollDisabled) <= soakCompletedAt) fail("poll-disabled-before-soak");
  if (normalizedRecordedAt(pollInventory) >= normalizedRecordedAt(pollDisabled)) {
    fail("poll-inventory-not-before-disable");
  }
  const pollIdentity = Object.fromEntries(
    pollIdentityFields.map((field) => [field, pollInventory.caseEvidence[field]]),
  );
  for (const record of [
    pollDisabled,
    pollIntervalOne,
    pollIntervalTwo,
    pollObserved,
    pollDm,
    pollMention,
  ]) {
    for (const field of pollIdentityFields.filter(
      (name) => name !== "pollOwnerId" && name !== "pollSchedule",
    )) {
      if (record.caseEvidence[field] !== pollIdentity[field])
        fail(`poll-identity-mismatch:${field}`);
    }
    if (!isAcceptedRecord(record)) {
      for (const field of ["pollOwnerId", "pollSchedule"]) {
        if (record.caseEvidence[field] !== pollIdentity[field])
          fail(`poll-identity-mismatch:${field}`);
      }
    }
  }
  const disabledAt = Date.parse(pollDisabled.caseEvidence.disabledAt);
  const intervalOneStartedAt = Date.parse(pollIntervalOne.caseEvidence.windowStartedAt);
  const intervalOneEndedAt = Date.parse(pollIntervalOne.caseEvidence.windowEndedAt);
  const intervalTwoStartedAt = Date.parse(pollIntervalTwo.caseEvidence.windowStartedAt);
  const intervalTwoEndedAt = Date.parse(pollIntervalTwo.caseEvidence.windowEndedAt);
  if (
    intervalOneStartedAt !== disabledAt ||
    intervalOneEndedAt - intervalOneStartedAt < FIFTEEN_MINUTES_MS ||
    intervalTwoStartedAt !== intervalOneEndedAt ||
    intervalTwoEndedAt - intervalTwoStartedAt < FIFTEEN_MINUTES_MS ||
    Date.parse(pollObserved.caseEvidence.observationStartedAt) !== disabledAt ||
    Date.parse(pollObserved.caseEvidence.observationEndedAt) < intervalTwoEndedAt
  ) {
    fail("poll-window-coverage-invalid");
  }
  if (
    normalizedRecordedAt(pollIntervalOne) - normalizedRecordedAt(pollDisabled) <
      FIFTEEN_MINUTES_MS ||
    normalizedRecordedAt(pollIntervalTwo) - normalizedRecordedAt(pollIntervalOne) <
      FIFTEEN_MINUTES_MS ||
    normalizedRecordedAt(pollObserved) < normalizedRecordedAt(pollIntervalTwo) ||
    normalizedRecordedAt(pollObserved) - normalizedRecordedAt(pollDisabled) < THIRTY_MINUTES_MS
  ) {
    fail("poll-observation-too-short");
  }
  if (
    Date.parse(pollDm.messageCommittedAt) <= normalizedRecordedAt(pollObserved) ||
    Date.parse(pollMention.messageCommittedAt) <= normalizedRecordedAt(pollObserved)
  ) {
    fail("push-only-check-before-poll-observation");
  }
  if (
    pollDm.caseEvidence.pollSourceAuditId !== pollMention.caseEvidence.pollSourceAuditId ||
    pollDm.caseEvidence.pollExecutionCountSinceDisable !== 0 ||
    pollMention.caseEvidence.pollExecutionCountSinceDisable !== 0
  ) {
    fail("push-only-source-audit-invalid");
  }

  return {
    recordCount: records.length,
    directMessageCount: directMessages.length,
    verifiedMentionCount: verifiedMentions.length,
    duplicateReplayCount: replayRecords.length,
    suppressedCount: suppressedRecords.length,
    p95LatencyMs,
    maximumLatencyMs,
    hostCount: hostIds.size,
  };
}

function sameArtifactMetadata(left, right) {
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

function validatePrivateArtifactMetadata(metadata) {
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (
    !metadata.isFile() ||
    metadata.size <= 0n ||
    metadata.size > BigInt(MAX_AUTHORITY_REFERENCE_BYTES) ||
    (metadata.mode & 0o77n) !== 0n ||
    (currentUid !== null && metadata.uid !== currentUid && metadata.uid !== 0n)
  ) {
    fail("artifact-file-metadata-invalid");
  }
}

export function validateAgentWakeAuthorityReferenceArtifact(content, record) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    value = JSON.parse(text);
  } catch {
    fail("artifact-content-invalid");
  }
  if (
    text !== `${JSON.stringify(value)}\n` ||
    !hasExactKeys(value, [
      "authorityId",
      "authorityKind",
      "caseId",
      "independentReviewRequired",
      "observationId",
      "runId",
      "subjectDigestSha256",
      "targetBotId",
      "targetIdentityAuthorityId",
      "type",
      "version",
    ]) ||
    value.version !== 1 ||
    value.type !== "agent.wake.authority_reference" ||
    value.runId !== record.runId ||
    value.caseId !== record.caseId ||
    value.targetBotId !== record.targetBotId ||
    value.targetIdentityAuthorityId !== record.targetIdentityAuthorityId ||
    value.authorityKind !== record.caseEvidence.authorityKind ||
    value.authorityId !== record.caseEvidence.authorityId ||
    value.observationId !== record.caseEvidence.observationId ||
    typeof value.subjectDigestSha256 !== "string" ||
    !hashPattern.test(value.subjectDigestSha256) ||
    value.independentReviewRequired !== true
  ) {
    fail("artifact-content-invalid");
  }
}

async function verifiedArtifactDirectory(artifactDirectory) {
  if (typeof artifactDirectory !== "string" || !path.isAbsolute(artifactDirectory)) {
    fail("artifact-directory-not-absolute");
  }
  let metadata;
  try {
    metadata = await lstat(artifactDirectory, { bigint: true });
  } catch {
    fail("artifact-directory-unavailable");
  }
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o77n) !== 0n ||
    (currentUid !== null && metadata.uid !== currentUid && metadata.uid !== 0n)
  ) {
    fail("artifact-directory-metadata-invalid");
  }
  try {
    return await realpath(artifactDirectory);
  } catch {
    fail("artifact-directory-unavailable");
  }
}

async function verifyArtifact(artifactDirectory, record) {
  const artifactPath = path.join(artifactDirectory, record.evidenceReference);
  let handle;
  try {
    handle = await open(
      artifactPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    fail("artifact-file-unavailable");
  }
  let closeFailed = false;
  try {
    const metadataBefore = await handle.stat({ bigint: true });
    validatePrivateArtifactMetadata(metadataBefore);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(ARTIFACT_HASH_BUFFER_BYTES);
    const chunks = [];
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      digest.update(chunk);
      chunks.push(chunk);
    }
    const metadataAfter = await handle.stat({ bigint: true });
    if (!sameArtifactMetadata(metadataBefore, metadataAfter)) fail("artifact-file-changed");
    if (digest.digest("hex") !== record.evidenceDigestSha256) fail("artifact-digest-mismatch");
    validateAgentWakeAuthorityReferenceArtifact(Buffer.concat(chunks), record);
  } finally {
    try {
      await handle.close();
    } catch {
      closeFailed = true;
    }
  }
  if (closeFailed) fail("artifact-file-unavailable");
}

async function validateReferencedArtifacts(records, artifactDirectory) {
  const canonicalDirectory = await verifiedArtifactDirectory(artifactDirectory);
  const references = new Map();
  for (const record of records) {
    if (references.has(record.evidenceReference)) fail("artifact-reference-reused");
    references.set(record.evidenceReference, record);
  }
  for (const record of references.values()) {
    await verifyArtifact(canonicalDirectory, record);
  }
  return references.size;
}

export async function validateAgentWakeEvidenceManifest(evidencePath, artifactDirectory) {
  if (typeof evidencePath !== "string" || !path.isAbsolute(evidencePath)) {
    fail("evidence-path-not-absolute");
  }
  let handle;
  try {
    handle = await open(
      evidencePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    fail("evidence-file-unavailable");
  }
  let closeFailed = false;
  let result;
  try {
    const metadataBefore = await handle.stat({ bigint: true });
    if (!metadataBefore.isFile()) fail("evidence-file-not-regular");
    if (metadataBefore.size <= 0n || metadataBefore.size > BigInt(MAX_EVIDENCE_BYTES)) {
      fail("evidence-file-size-invalid");
    }
    if ((metadataBefore.mode & 0o77n) !== 0n) fail("evidence-file-accessible-by-others");
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    if (currentUid !== null && metadataBefore.uid !== currentUid && metadataBefore.uid !== 0n) {
      fail("evidence-file-owner-invalid");
    }
    const bytes = await handle.readFile();
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("evidence-utf8-invalid");
    }
    const metadataAfter = await handle.stat({ bigint: true });
    if (!sameArtifactMetadata(metadataBefore, metadataAfter)) fail("evidence-file-changed");
    const records = parseAgentWakeEvidenceManifest(source);
    const summary = validateAgentWakeEvidenceRecords(records);
    const artifactCount = await validateReferencedArtifacts(records, artifactDirectory);
    result = { ...summary, artifactCount };
  } finally {
    try {
      await handle.close();
    } catch {
      closeFailed = true;
    }
  }
  if (closeFailed) fail("evidence-file-unavailable");
  return result;
}

function parseArguments(args) {
  if (
    args.length !== 3 ||
    args[0] !== "--artifacts" ||
    !path.isAbsolute(args[1]) ||
    !path.isAbsolute(args[2])
  ) {
    fail("usage");
  }
  return { artifactDirectory: args[1], evidencePath: args[2] };
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const summary = await validateAgentWakeEvidenceManifest(
      options.evidencePath,
      options.artifactDirectory,
    );
    console.log(
      `Validated Agent Wake evidence manifest structure and artifact integrity: ${summary.recordCount} records, ${summary.artifactCount} artifacts, ${summary.directMessageCount} DMs, ${summary.verifiedMentionCount} mentions, p95 ${summary.p95LatencyMs} ms. Independent rollout review is still required.`,
    );
  } catch (error) {
    console.error(
      error instanceof AgentWakeEvidenceManifestError
        ? error.message
        : "Agent Wake evidence manifest validation failed: validator-error",
    );
    process.exitCode = 1;
  }
}
