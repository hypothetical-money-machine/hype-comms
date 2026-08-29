import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentWakeEvidenceManifestError,
  parseAgentWakeEvidenceManifest,
  validateAgentWakeEvidenceManifest,
  validateAgentWakeEvidenceRecords,
} from "./validate-agent-wake-evidence-manifest.mjs";

const START_MS = Date.parse("2026-08-23T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOST_ONE = "wake-host-macos-primary";
const HOST_TWO = "wake-host-macos-failover";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_USER_ID = "20000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "30000000-0000-4000-8000-000000000003";
const TARGET_BOT_ID = "xai-grok-bot-woots-production";
const TARGET_IDENTITY_AUTHORITY_ID = "xai-bot-directory-woots-production";
const SOAK_RUN_ID = "wake-soak-2026-08-23";
const POLL_SYSTEM_ID = "cursor-routines-production";
const POLL_AUTOMATION_ID = "automation-woots-comms-poll";
const POLL_JOB_ID = "job-woots-comms-poll-15m";
const POLL_OWNER_ID = "owner-woots-production";
const POLL_SCHEDULE = "PT15M";

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

const ordinaryCases = [
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
];

const actionForCase = new Map([
  ["operator-confirm-accepted", "confirm-accepted"],
  ["operator-confirm-duplicate", "confirm-duplicate"],
  ["operator-confirm-coalesced", "confirm-coalesced"],
  ["operator-provider-retry", "provider-retry"],
  ["operator-source-reset-from-now", "source-reset-from-now"],
  ["operator-resume", "resume"],
]);

const ordinaryEvidence = new Map([
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

const securitySurface = new Map([
  ["security-cli-stdout", "cli_stdout"],
  ["security-durable-state", "durable_state"],
  ["security-provider-stdin", "provider_stdin"],
  ["security-renderer-ipc", "renderer_ipc"],
  ["security-structured-logs", "structured_logs"],
  ["security-rollout-evidence", "rollout_evidence"],
  ["security-credential-handles", "credential_handle_projection"],
]);

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function uuid(number) {
  return `40000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
}

function wakeId(messageId) {
  return createHash("sha256")
    .update(JSON.stringify(["hype-wake-v1", WORKSPACE_ID, AGENT_USER_ID, messageId]), "utf8")
    .digest("hex");
}

function artifactContent(record) {
  return Buffer.from(
    `${JSON.stringify({
      version: 1,
      type: "agent.wake.authority_reference",
      runId: record.runId,
      caseId: record.caseId,
      targetBotId: record.targetBotId,
      targetIdentityAuthorityId: record.targetIdentityAuthorityId,
      authorityKind: record.caseEvidence.authorityKind,
      authorityId: record.caseEvidence.authorityId,
      observationId: record.caseEvidence.observationId,
      subjectDigestSha256: createHash("sha256")
        .update(`authority-subject:${record.caseId}`, "utf8")
        .digest("hex"),
      independentReviewRequired: true,
    })}\n`,
    "utf8",
  );
}

function artifactDigest(record) {
  return createHash("sha256").update(artifactContent(record)).digest("hex");
}

function authority(caseId, authorityKind, observedAt) {
  return {
    authorityKind,
    authorityId: `${authorityKind}-authority`,
    observationId: `observation-${caseId}`,
    observedAt: iso(observedAt),
  };
}

function ordinaryCaseEvidence(caseId, recordedAt) {
  const requirement = ordinaryEvidence.get(caseId);
  if (requirement === undefined) throw new Error(`Missing ordinary evidence: ${caseId}`);
  const [authorityKind, outcome, targetInvocationCount] = requirement;
  return {
    type: "case_observation",
    ...authority(caseId, authorityKind, recordedAt),
    inducedAt: iso(recordedAt - (caseId === "token-revocation" ? 30_000 : 100)),
    outcome,
    targetInvocationCount,
  };
}

function securityCaseEvidence(caseId, recordedAt) {
  return {
    type: "security_scan",
    ...authority(caseId, "independent_security_review", recordedAt),
    surface: securitySurface.get(caseId),
    messageBodyMatches: 0,
    promptMatches: 0,
    historyMatches: 0,
    agentTokenMatches: 0,
    providerCredentialMatches: 0,
    childOutputMatches: 0,
    credentialHandleMatches: 0,
  };
}

function makeFixture() {
  const records = [];
  let cursor = 1;
  let messageNumber = 1;
  let currentMs = START_MS;
  let currentHost = HOST_ONE;

  const base = (caseId, scenario, recordedAt = currentMs) => {
    const evidenceReference = `artifact-${caseId}`;
    return {
      version: 1,
      type: "agent.wake.rollout_evidence",
      recordedAt: iso(recordedAt),
      runId: "50000000-0000-4000-8000-000000000005",
      caseId,
      scenario,
      result: "pass",
      gitCommit: "a".repeat(40),
      appVersion: "0.1.0",
      buildFlavor: "production",
      platform: "darwin",
      architecture: "arm64",
      clockSkewMs: 0,
      wakeHostId: currentHost,
      enrollmentId: "actual-grok-bot-wake",
      agentIdentityLabel: "Woots-production",
      targetKind: "grok_bot",
      targetBotId: TARGET_BOT_ID,
      targetIdentityAuthorityId: TARGET_IDENTITY_AUTHORITY_ID,
      adapterId: "grok-bot-event-routine-v1",
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_USER_ID,
      conversationId: null,
      messageId: null,
      wakeId: null,
      reason: null,
      sourceCursor: String(cursor++),
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
      caseEvidence:
        scenario === "security"
          ? securityCaseEvidence(caseId, recordedAt)
          : ordinaryEvidence.has(caseId)
            ? ordinaryCaseEvidence(caseId, recordedAt)
            : {},
      evidenceReference,
      evidenceDigestSha256: "0".repeat(64),
    };
  };

  const accepted = (caseId, scenario, committedAt = currentMs) => {
    const messageId = uuid(messageNumber++);
    const acceptedAt = committedAt + 1_000;
    const observedAt = acceptedAt + 1_000;
    const record = {
      ...base(caseId, scenario, observedAt),
      conversationId: CONVERSATION_ID,
      messageId,
      wakeId: wakeId(messageId),
      reason:
        scenario === "direct_message" || caseId === "poll-push-only-dm"
          ? "direct_message"
          : "verified_mention",
      attempt: 1,
      messageCommittedAt: iso(committedAt),
      brokerDurableAt: iso(committedAt + 100),
      providerAcceptedAt: iso(acceptedAt),
      latencyMs: acceptedAt - committedAt,
      providerReceiptKind: "provider_issued",
      providerReceiptId: `provider-receipt-${messageNumber}`,
      providerActivityId: `provider-activity-${messageNumber}`,
      providerActivityObservedAt: iso(observedAt),
      exactMessageFetchEvidenceId: `exact-fetch-${messageNumber}`,
      caseEvidence: {
        type: "accepted_wake",
        ...authority(caseId, "provider_cli_correlation", observedAt),
        fetchClient: "hype-comms-cli",
        fetchCommand: "messages.get",
        fetchEvidenceId: `exact-fetch-${messageNumber}`,
        fetchedMessageId: messageId,
        fetchAgentUserId: AGENT_USER_ID,
        fetchObservedAt: iso(acceptedAt + 500),
        fetchResultCount: 1,
        historyRequestCount: 0,
        targetActivationCount: 1,
        wakeSource: "event_push",
        pollSystemId: caseId.startsWith("poll-push-only-") ? POLL_SYSTEM_ID : null,
        pollAutomationId: caseId.startsWith("poll-push-only-") ? POLL_AUTOMATION_ID : null,
        pollJobId: caseId.startsWith("poll-push-only-") ? POLL_JOB_ID : null,
        pollSourceAuditId: caseId.startsWith("poll-push-only-")
          ? "scheduler-push-only-source-audit"
          : null,
        pollExecutionCountSinceDisable: caseId.startsWith("poll-push-only-") ? 0 : null,
      },
    };
    records.push(record);
    currentMs = observedAt + 2_000;
    return record;
  };

  for (let index = 1; index <= 15; index += 1) {
    accepted(`latency-dm-${String(index).padStart(3, "0")}`, "direct_message");
  }
  for (let index = 1; index <= 14; index += 1) {
    accepted(`latency-mention-${String(index).padStart(3, "0")}`, "verified_mention");
  }
  accepted("latency-mention-precedence", "verified_mention");

  const replayTarget = records[0];
  const applyWakePointer = (record) => {
    record.conversationId = replayTarget.conversationId;
    record.messageId = replayTarget.messageId;
    record.wakeId = replayTarget.wakeId;
    record.reason = replayTarget.reason;
    record.attempt = 1;
    record.messageCommittedAt = replayTarget.messageCommittedAt;
    record.brokerDurableAt = replayTarget.brokerDurableAt;
  };
  for (let index = 1; index <= 100; index += 1) {
    currentMs += 1;
    const caseId = `duplicate-replay-${String(index).padStart(3, "0")}`;
    records.push({
      ...base(caseId, "replay"),
      conversationId: replayTarget.conversationId,
      messageId: replayTarget.messageId,
      wakeId: replayTarget.wakeId,
      reason: replayTarget.reason,
      sourceCursor: replayTarget.sourceCursor,
      messageCommittedAt: replayTarget.messageCommittedAt,
      caseEvidence: {
        type: "dedupe_replay",
        ...authority(caseId, "wake_broker", currentMs),
        originalProviderActivityId: replayTarget.providerActivityId,
        targetInvocationCount: 0,
      },
    });
  }

  for (let index = 1; index <= 1_000; index += 1) {
    currentMs += 1;
    const category = suppressedCategories[(index - 1) % suppressedCategories.length];
    const messageId = uuid(messageNumber++);
    const caseId = `suppressed-${category}-${String(index).padStart(4, "0")}`;
    const record = {
      ...base(caseId, "suppressed"),
      conversationId: CONVERSATION_ID,
      messageId,
      messageCommittedAt: iso(currentMs - 1),
    };
    record.caseEvidence = {
      type: "suppressed_event",
      ...authority(caseId, "wake_broker", currentMs),
      checkpointCursor: record.sourceCursor,
      checkpointDurableAt: iso(currentMs),
      targetInvocationCount: 0,
    };
    records.push(record);
  }

  for (const [caseId, scenario] of ordinaryCases) {
    currentMs += 1_000;
    if (caseId === "host-controlled-failover") currentHost = HOST_TWO;
    const record = base(caseId, scenario);
    record.operatorAction = actionForCase.get(caseId) ?? null;
    if (caseId === "cursor-expiry") record.repairCode = "source-cursor-expired";
    if (caseId === "server-reset") record.repairCode = "source-server-reset";
    if (caseId === "token-revocation") record.repairCode = "source-authentication-required";
    if (caseId === "crash-after-possible-target" || caseId === "completion-store-recovery") {
      record.repairCode = "provider-outcome-ambiguous";
      applyWakePointer(record);
    }
    if (
      caseId === "operator-confirm-accepted" ||
      caseId === "operator-confirm-duplicate" ||
      caseId === "operator-confirm-coalesced"
    ) {
      record.repairCode = "provider-outcome-ambiguous";
      applyWakePointer(record);
      record.providerAcceptedAt = iso(currentMs - 1_000);
      record.latencyMs = currentMs - 1_000 - Date.parse(record.messageCommittedAt);
      record.providerReceiptKind = "provider_issued";
      record.providerReceiptId = `operator-receipt-${caseId}`;
      record.providerActivityId = replayTarget.providerActivityId;
      record.providerActivityObservedAt = record.recordedAt;
    }
    if (caseId === "operator-provider-retry") {
      record.repairCode = "provider-outcome-ambiguous";
      applyWakePointer(record);
    }
    if (caseId === "operator-source-reset-from-now") {
      record.repairCode = "source-cursor-expired";
    }
    records.push(record);
  }

  accepted("soak-post-failover-dm", "direct_message");

  const failoverAt = Date.parse(
    records.find((record) => record.caseId === "host-controlled-failover").recordedAt,
  );
  for (let index = 0; index <= 96; index += 1) {
    const heartbeatAt = START_MS + 30_000 + index * 15 * 60 * 1_000;
    currentHost = heartbeatAt < failoverAt ? HOST_ONE : HOST_TWO;
    const caseId = `soak-heartbeat-${String(index + 1).padStart(3, "0")}`;
    const record = base(caseId, "soak", heartbeatAt);
    record.caseEvidence = {
      type: "soak_heartbeat",
      ...authority(caseId, "wake_broker", heartbeatAt),
      soakRunId: SOAK_RUN_ID,
      brokerState: "running",
      queueDepth: 0,
      completionLedgerSize: 31,
      providerLedgerSize: 31,
      repairCode: null,
    };
    records.push(record);
  }
  currentHost = HOST_TWO;
  currentMs = START_MS + DAY_MS + 5 * 60 * 1_000;
  const soakSummary = base("soak-summary", "soak");
  soakSummary.caseEvidence = {
    type: "soak_summary",
    ...authority("soak-summary", "wake_broker", currentMs),
    soakRunId: SOAK_RUN_ID,
    soakStartedAt: iso(START_MS),
    soakCompletedAt: iso(currentMs),
    eligibleWakeCount: 31,
    targetActivationCount: 31,
    lostEligibleWakeCount: 0,
    duplicateActivationCount: 0,
    maximumQueueDepth: 100,
    maximumCompletionLedgerSize: 2_048,
    maximumProviderLedgerSize: 2_048,
    finalRepairCode: null,
    childrenAliveAfterShutdown: 0,
  };
  records.push(soakSummary);
  currentMs += 60_000;
  const pollIdentity = {
    pollSystemId: POLL_SYSTEM_ID,
    pollAutomationId: POLL_AUTOMATION_ID,
    pollJobId: POLL_JOB_ID,
    pollOwnerId: POLL_OWNER_ID,
    pollSchedule: POLL_SCHEDULE,
  };
  const pollInventory = base("poll-inventory", "poll_retirement");
  pollInventory.caseEvidence = {
    type: "poll_inventory",
    ...authority("poll-inventory", "scheduler", currentMs),
    ...pollIdentity,
    enabled: true,
    lastSuccessfulRunAt: iso(currentMs - 15 * 60 * 1_000),
  };
  records.push(pollInventory);
  currentMs += 60_000;
  const pollDisabledAt = currentMs;
  const pollDisabled = base("poll-disabled", "poll_retirement");
  pollDisabled.caseEvidence = {
    type: "poll_disabled",
    ...authority("poll-disabled", "scheduler", currentMs),
    ...pollIdentity,
    approvedChangeId: "change-disable-woots-comms-poll",
    schedulerAuditId: "scheduler-disable-audit",
    disabledAt: iso(currentMs),
  };
  records.push(pollDisabled);
  currentMs += 15 * 60 * 1_000;
  const pollIntervalOne = base("poll-interval-01-zero", "poll_retirement");
  pollIntervalOne.caseEvidence = {
    type: "poll_zero_execution_window",
    ...authority("poll-interval-01-zero", "scheduler", currentMs),
    ...pollIdentity,
    windowIndex: 1,
    windowStartedAt: iso(pollDisabledAt),
    windowEndedAt: iso(currentMs),
    executionCount: 0,
    schedulerAuditId: "scheduler-window-audit-01",
  };
  records.push(pollIntervalOne);
  currentMs += 15 * 60 * 1_000;
  const pollIntervalTwo = base("poll-interval-02-zero", "poll_retirement");
  pollIntervalTwo.caseEvidence = {
    type: "poll_zero_execution_window",
    ...authority("poll-interval-02-zero", "scheduler", currentMs),
    ...pollIdentity,
    windowIndex: 2,
    windowStartedAt: iso(currentMs - 15 * 60 * 1_000),
    windowEndedAt: iso(currentMs),
    executionCount: 0,
    schedulerAuditId: "scheduler-window-audit-02",
  };
  records.push(pollIntervalTwo);
  currentMs += 1_000;
  const pollSummary = base("poll-two-intervals-zero", "poll_retirement");
  pollSummary.caseEvidence = {
    type: "poll_zero_execution_summary",
    ...authority("poll-two-intervals-zero", "scheduler", currentMs),
    ...pollIdentity,
    observationStartedAt: iso(pollDisabledAt),
    observationEndedAt: iso(currentMs - 1_000),
    executionCount: 0,
    schedulerAuditId: "scheduler-two-window-audit",
  };
  records.push(pollSummary);
  currentMs += 60_000;
  accepted("poll-push-only-dm", "poll_retirement");
  currentMs += 60_000;
  accepted("poll-push-only-mention", "poll_retirement");

  for (const record of records) record.evidenceDigestSha256 = artifactDigest(record);
  return records.sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
}

function expectCode(code) {
  return (error) =>
    error instanceof AgentWakeEvidenceManifestError &&
    (error.code === code || error.code.startsWith(`${code}:`));
}

test("validates the complete strict rollout manifest", () => {
  const summary = validateAgentWakeEvidenceRecords(makeFixture());

  assert.deepEqual(summary, {
    recordCount: 1_300,
    directMessageCount: 15,
    verifiedMentionCount: 15,
    duplicateReplayCount: 100,
    suppressedCount: 1_000,
    p95LatencyMs: 1_000,
    maximumLatencyMs: 1_000,
    hostCount: 2,
  });
});

test("parses strict body-free NDJSON", () => {
  const records = makeFixture();
  const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

  assert.equal(parseAgentWakeEvidenceManifest(text).length, records.length);

  const withBody = structuredClone(records);
  withBody[0].body = "forbidden";
  assert.throws(
    () => parseAgentWakeEvidenceManifest(`${JSON.stringify(withBody[0])}\n`),
    expectCode("record-fields-invalid"),
  );
  const duplicateKey = JSON.stringify(records[0]).replace('"version":1', '"version":0,"version":1');
  assert.throws(
    () => parseAgentWakeEvidenceManifest(`${duplicateKey}\n`),
    expectCode("json-not-canonical"),
  );
  assert.throws(
    () => parseAgentWakeEvidenceManifest("{}\n\n"),
    expectCode("record-fields-invalid"),
  );
});

test("the composed manifest validator does not revalidate parsed records", async () => {
  const source = await readFile(
    new URL("./validate-agent-wake-evidence-manifest.mjs", import.meta.url),
    "utf8",
  );
  const entryPointStart = source.indexOf("export async function validateAgentWakeEvidenceManifest");
  const entryPointEnd = source.indexOf("\nfunction parseArguments", entryPointStart);
  const entryPoint = source.slice(entryPointStart, entryPointEnd);

  assert.ok(entryPointStart >= 0 && entryPointEnd > entryPointStart);
  assert.doesNotMatch(entryPoint, /validateAgentWakeEvidenceRecords\(records\)/u);
  assert.match(entryPoint, /validateParsedAgentWakeEvidenceRecords\(records\)/u);
});

test("rejects placeholder identities and non-authoritative accepted receipts", () => {
  const placeholder = makeFixture();
  placeholder[0].agentIdentityLabel = "grok-bot-pilot";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(placeholder),
    expectCode("agent-label-placeholder"),
  );

  const localReceipt = makeFixture();
  localReceipt[0].providerReceiptKind = "adapter_issued";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(localReceipt),
    expectCode("accepted-receipt-not-authoritative"),
  );
});

test("requires an actual Grok Bot binding and the existing exact-fetch CLI path", () => {
  const wren = makeFixture();
  for (const record of wren) record.agentIdentityLabel = "Wren";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(wren),
    expectCode("agent-label-placeholder"),
  );

  const wrenTarget = makeFixture();
  for (const record of wrenTarget) record.targetBotId = "wren-production";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(wrenTarget),
    expectCode("target-bot-id-invalid"),
  );

  const wrongKind = makeFixture();
  for (const record of wrongKind) record.targetKind = "desktop_agent";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(wrongKind),
    expectCode("target-kind-invalid"),
  );

  const historyClient = makeFixture();
  historyClient[0].caseEvidence.fetchClient = "conversation-history-client";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(historyClient),
    expectCode("accepted-fetch-client-invalid"),
  );

  const wrongMessage = makeFixture();
  wrongMessage[0].caseEvidence.fetchedMessageId = uuid(99_999);
  assert.throws(
    () => validateAgentWakeEvidenceRecords(wrongMessage),
    expectCode("accepted-fetch-message-mismatch"),
  );

  const wrongFetchEvidence = makeFixture();
  wrongFetchEvidence[0].caseEvidence.fetchEvidenceId = "some-other-fetch";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(wrongFetchEvidence),
    expectCode("accepted-fetch-evidence-id-mismatch"),
  );

  const historyRequest = makeFixture();
  historyRequest[0].caseEvidence.historyRequestCount = 1;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(historyRequest),
    expectCode("accepted-history-request-count-invalid"),
  );
});

test("rejects a wake ID that is not derived from the logical key", () => {
  const records = makeFixture();
  records[0].wakeId = "f".repeat(64);

  assert.throws(() => validateAgentWakeEvidenceRecords(records), expectCode("wake-id-mismatch"));
});

test("rejects duplicate case IDs and incomplete count gates", () => {
  const duplicate = makeFixture();
  duplicate[1].caseId = duplicate[0].caseId;
  assert.throws(() => validateAgentWakeEvidenceRecords(duplicate), expectCode("case-id-duplicate"));

  const insufficient = makeFixture().filter((record) => record.caseId !== "duplicate-replay-100");
  assert.throws(
    () => validateAgentWakeEvidenceRecords(insufficient),
    expectCode("duplicate-replay-count-insufficient"),
  );

  const missingHeartbeat = makeFixture().filter((record) => record.caseId !== "soak-heartbeat-097");
  assert.throws(
    () => validateAgentWakeEvidenceRecords(missingHeartbeat),
    expectCode("soak-heartbeat-count-insufficient"),
  );
});

test("requires durable cursor progression and replay chronology", () => {
  const stationaryCursor = makeFixture();
  for (const record of stationaryCursor) {
    record.sourceCursor = "1";
    if (record.scenario === "suppressed") record.caseEvidence.checkpointCursor = "1";
  }
  assert.throws(
    () => validateAgentWakeEvidenceRecords(stationaryCursor),
    expectCode("source-cursor-did-not-advance"),
  );

  const earlyReplay = makeFixture();
  let offset = 0;
  for (const record of earlyReplay.filter((candidate) => candidate.scenario === "replay")) {
    record.recordedAt = iso(START_MS - 60_000 + offset++);
    record.caseEvidence.observedAt = record.recordedAt;
    record.wakeHostId = HOST_ONE;
  }
  earlyReplay.sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
  assert.throws(
    () => validateAgentWakeEvidenceRecords(earlyReplay),
    expectCode("replay-before-original-activity"),
  );
});

test("requires typed failure and zero-leak security observations", () => {
  const missingInducedAt = makeFixture();
  missingInducedAt.find(
    (record) => record.caseId === "executable-runtime-hash-rejected",
  ).caseEvidence.inducedAt = null;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(missingInducedAt),
    expectCode("case-induced-at-missing"),
  );

  const wrongOutcome = makeFixture();
  wrongOutcome.find((record) => record.caseId === "fresh-auth-start").caseEvidence.outcome =
    "claimed-pass";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(wrongOutcome),
    expectCode("case-outcome-mismatch"),
  );

  const lateRevocation = makeFixture();
  const revocation = lateRevocation.find((record) => record.caseId === "token-revocation");
  revocation.caseEvidence.inducedAt = iso(Date.parse(revocation.recordedAt) - 60_001);
  assert.throws(
    () => validateAgentWakeEvidenceRecords(lateRevocation),
    expectCode("revocation-repair-too-late"),
  );

  const leakedBody = makeFixture();
  leakedBody.find(
    (record) => record.caseId === "security-cli-stdout",
  ).caseEvidence.messageBodyMatches = 1;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(leakedBody),
    expectCode("security-messageBodyMatches-nonzero"),
  );
});

test("requires the exact ambiguous wake in recovery evidence", () => {
  const records = makeFixture();
  const recovery = records.find((record) => record.caseId === "completion-store-recovery");
  recovery.wakeId = null;

  assert.throws(
    () => validateAgentWakeEvidenceRecords(records),
    expectCode("completion-recovery-wakeId-missing"),
  );
});

test("enforces p95 and maximum latency", () => {
  const unnormalized = makeFixture();
  unnormalized[0].clockSkewMs = -100;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(unnormalized),
    expectCode("accepted-latency-mismatch"),
  );

  const normalizedP95 = makeFixture();
  for (const record of normalizedP95.slice(0, 2)) {
    const committedAt = Date.parse(record.messageCommittedAt);
    record.clockSkewMs = -100;
    record.providerAcceptedAt = iso(committedAt + 5_000);
    record.caseEvidence.fetchObservedAt = iso(committedAt + 5_000);
    record.providerActivityObservedAt = iso(committedAt + 5_000);
    record.recordedAt = iso(committedAt + 5_000);
    record.caseEvidence.observedAt = record.recordedAt;
    record.latencyMs = 5_100;
  }
  assert.throws(
    () => validateAgentWakeEvidenceRecords(normalizedP95),
    expectCode("latency-p95-exceeded"),
  );

  const p95 = makeFixture();
  for (const record of p95.slice(0, 2)) {
    record.messageCommittedAt = iso(Date.parse(record.messageCommittedAt) - 4_001);
    record.latencyMs = 5_001;
  }
  assert.throws(() => validateAgentWakeEvidenceRecords(p95), expectCode("latency-p95-exceeded"));

  const maximum = makeFixture();
  maximum[0].messageCommittedAt = iso(Date.parse(maximum[0].messageCommittedAt) - 30_001);
  maximum[0].latencyMs = 31_001;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(maximum),
    expectCode("latency-maximum-exceeded"),
  );
});

test("enforces the 24-hour soak, controlled failover, and poll retirement interval", () => {
  const clockInvertedFailover = makeFixture();
  const election = clockInvertedFailover.find(
    (record) => record.caseId === "host-election-single-active",
  );
  const failover = clockInvertedFailover.find(
    (record) => record.caseId === "host-controlled-failover",
  );
  const failoverRecordedAt = Date.parse(failover.recordedAt);
  election.recordedAt = iso(failoverRecordedAt - 1);
  election.caseEvidence.observedAt = election.recordedAt;
  election.caseEvidence.inducedAt = iso(failoverRecordedAt - 101);
  election.clockSkewMs = -100;
  failover.clockSkewMs = 100;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(clockInvertedFailover),
    expectCode("records-not-chronological"),
  );

  const clockShortSoak = makeFixture();
  const firstAcceptedAt = Math.min(
    ...clockShortSoak
      .filter(
        (record) => record.scenario === "direct_message" || record.scenario === "verified_mention",
      )
      .map((record) => Date.parse(record.messageCommittedAt)),
  );
  const exactRawSoakEnd = firstAcceptedAt + DAY_MS;
  const lastHeartbeat = clockShortSoak
    .filter((record) => record.caseId.startsWith("soak-heartbeat-"))
    .at(-1);
  lastHeartbeat.recordedAt = iso(exactRawSoakEnd - 100);
  lastHeartbeat.caseEvidence.observedAt = lastHeartbeat.recordedAt;
  const clockShortSummary = clockShortSoak.find((record) => record.caseId === "soak-summary");
  clockShortSummary.recordedAt = iso(exactRawSoakEnd);
  clockShortSummary.caseEvidence.observedAt = clockShortSummary.recordedAt;
  clockShortSummary.caseEvidence.soakCompletedAt = clockShortSummary.recordedAt;
  clockShortSummary.clockSkewMs = 100;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(clockShortSoak),
    expectCode("soak-too-short"),
  );

  const shortSoak = makeFixture();
  const heartbeats = shortSoak.filter((record) => record.caseId.startsWith("soak-heartbeat-"));
  for (const [index, heartbeat] of heartbeats.entries()) {
    heartbeat.recordedAt = iso(START_MS + 30_000 + index * 14 * 60 * 1_000);
    heartbeat.caseEvidence.observedAt = heartbeat.recordedAt;
    heartbeat.wakeHostId =
      Date.parse(heartbeat.recordedAt) <
      Date.parse(
        shortSoak.find((record) => record.caseId === "host-controlled-failover").recordedAt,
      )
        ? HOST_ONE
        : HOST_TWO;
  }
  const soak = shortSoak.find((record) => record.caseId === "soak-summary");
  soak.recordedAt = iso(START_MS + DAY_MS - 10 * 60 * 1_000);
  soak.caseEvidence.observedAt = soak.recordedAt;
  soak.caseEvidence.soakCompletedAt = soak.recordedAt;
  assert.throws(() => validateAgentWakeEvidenceRecords(shortSoak), expectCode("soak-too-short"));

  const oneHost = makeFixture();
  for (const record of oneHost) record.wakeHostId = HOST_ONE;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(oneHost),
    expectCode("controlled-failover-host-count-invalid"),
  );

  const shortPoll = makeFixture();
  const disabled = shortPoll.find((record) => record.caseId === "poll-disabled");
  const intervalOne = shortPoll.find((record) => record.caseId === "poll-interval-01-zero");
  const intervalTwo = shortPoll.find((record) => record.caseId === "poll-interval-02-zero");
  const observed = shortPoll.find((record) => record.caseId === "poll-two-intervals-zero");
  intervalOne.recordedAt = iso(Date.parse(disabled.recordedAt) + 14 * 60 * 1_000);
  intervalTwo.recordedAt = iso(Date.parse(disabled.recordedAt) + 29 * 60 * 1_000);
  observed.recordedAt = iso(Date.parse(intervalTwo.recordedAt) + 1_000);
  intervalOne.caseEvidence.observedAt = intervalOne.recordedAt;
  intervalOne.caseEvidence.windowEndedAt = intervalOne.recordedAt;
  intervalTwo.caseEvidence.observedAt = intervalTwo.recordedAt;
  intervalTwo.caseEvidence.windowStartedAt = intervalOne.recordedAt;
  intervalTwo.caseEvidence.windowEndedAt = intervalTwo.recordedAt;
  observed.caseEvidence.observedAt = observed.recordedAt;
  observed.caseEvidence.observationEndedAt = intervalTwo.recordedAt;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(shortPoll),
    expectCode("poll-window-coverage-invalid"),
  );

  const clockShortPoll = makeFixture();
  clockShortPoll.find((record) => record.caseId === "poll-interval-01-zero").clockSkewMs = 100;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(clockShortPoll),
    expectCode("poll-observation-too-short"),
  );
});

test("requires soak cases, summary invariants, and a real host transition", () => {
  const outsideSoak = makeFixture();
  const outsideCaseIds = [
    "source-disconnect-reconnect-01",
    "source-disconnect-reconnect-02",
    "source-disconnect-reconnect-03",
    "source-disconnect-reconnect-04",
    "desktop-restart-01",
    "desktop-restart-02",
    "crash-before-target",
    "crash-after-possible-target",
    "completion-store-recovery",
  ];
  let offset = 0;
  for (const caseId of outsideCaseIds) {
    const record = outsideSoak.find((candidate) => candidate.caseId === caseId);
    record.recordedAt = iso(START_MS - 4 * 60 * 60 * 1_000 + offset++);
    record.caseEvidence.observedAt = record.recordedAt;
    record.caseEvidence.inducedAt = iso(Date.parse(record.recordedAt) - 100);
    record.wakeHostId = HOST_ONE;
  }
  outsideSoak.sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
  assert.throws(
    () => validateAgentWakeEvidenceRecords(outsideSoak),
    expectCode("soak-case-recorded-before-start"),
  );

  const lostWake = makeFixture();
  lostWake.find((record) => record.caseId === "soak-summary").caseEvidence.lostEligibleWakeCount =
    1;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(lostWake),
    expectCode("soak-summary-lost-wakes"),
  );

  const labelOnlyFailover = makeFixture();
  for (const record of labelOnlyFailover) record.wakeHostId = HOST_ONE;
  labelOnlyFailover.find((record) => record.caseId === "host-controlled-failover").wakeHostId =
    HOST_TWO;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(labelOnlyFailover),
    expectCode("controlled-failover-host-overlap"),
  );

  const extraProviderActivity = makeFixture();
  extraProviderActivity.find(
    (record) => record.caseId === "operator-confirm-duplicate",
  ).providerActivityId = "unrelated-extra-provider-activity";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(extraProviderActivity),
    expectCode("provider-confirmation-activity-mismatch:operator-confirm-duplicate"),
  );
});

test("pins poll retirement to one job, complete zero-execution windows, and push source audit", () => {
  const lateInventory = makeFixture();
  const inventory = lateInventory.find((record) => record.caseId === "poll-inventory");
  inventory.recordedAt = iso(
    Math.max(...lateInventory.map((record) => Date.parse(record.recordedAt))) + 60_000,
  );
  inventory.caseEvidence.observedAt = inventory.recordedAt;
  inventory.wakeHostId = HOST_TWO;
  lateInventory.sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
  assert.throws(
    () => validateAgentWakeEvidenceRecords(lateInventory),
    expectCode("poll-inventory-not-before-disable"),
  );

  const differentJob = makeFixture();
  differentJob.find((record) => record.caseId === "poll-interval-02-zero").caseEvidence.pollJobId =
    "some-other-poll-job";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(differentJob),
    expectCode("poll-identity-mismatch:pollJobId"),
  );

  const executionObserved = makeFixture();
  executionObserved.find(
    (record) => record.caseId === "poll-interval-01-zero",
  ).caseEvidence.executionCount = 1;
  assert.throws(
    () => validateAgentWakeEvidenceRecords(executionObserved),
    expectCode("poll-window-execution-count-nonzero"),
  );

  const differentSourceAudit = makeFixture();
  differentSourceAudit.find(
    (record) => record.caseId === "poll-push-only-mention",
  ).caseEvidence.pollSourceAuditId = "different-source-audit";
  assert.throws(
    () => validateAgentWakeEvidenceRecords(differentSourceAudit),
    expectCode("push-only-source-audit-invalid"),
  );
});

test("rejects any failed matrix record", () => {
  const records = makeFixture();
  records.find((record) => record.caseId === "package-notarization").result = "fail";

  assert.throws(() => validateAgentWakeEvidenceRecords(records), expectCode("case-failed"));
});

test("validates a private manifest and its artifact digests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-wake-rollout-"));
  const evidencePath = path.join(directory, "rollout.ndjson");
  const artifactDirectory = path.join(directory, "artifacts");
  try {
    const records = makeFixture();
    await mkdir(artifactDirectory, { mode: 0o700 });
    for (const record of records) {
      await writeFile(
        path.join(artifactDirectory, record.evidenceReference),
        artifactContent(record),
        { mode: 0o600 },
      );
    }
    await writeFile(
      evidencePath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await chmod(evidencePath, 0o600);

    const summary = await validateAgentWakeEvidenceManifest(evidencePath, artifactDirectory);
    assert.equal(summary.recordCount, records.length);
    assert.equal(summary.artifactCount, records.length);

    const failedRecords = structuredClone(records);
    failedRecords.find((record) => record.caseId === "package-notarization").result = "fail";
    await writeFile(
      evidencePath,
      `${failedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await assert.rejects(
      validateAgentWakeEvidenceManifest(evidencePath, artifactDirectory),
      expectCode("case-failed"),
    );

    await writeFile(evidencePath, Buffer.from([0xff]));
    await assert.rejects(
      validateAgentWakeEvidenceManifest(evidencePath, artifactDirectory),
      expectCode("evidence-utf8-invalid"),
    );
    await writeFile(
      evidencePath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const bodyBearingArtifact = JSON.parse(artifactContent(records[0]).toString("utf8"));
    bodyBearingArtifact.body = "forbidden-message-body";
    const bodyBearingContent = Buffer.from(`${JSON.stringify(bodyBearingArtifact)}\n`, "utf8");
    const bodyBearingRecords = structuredClone(records);
    bodyBearingRecords[0].evidenceDigestSha256 = createHash("sha256")
      .update(bodyBearingContent)
      .digest("hex");
    await writeFile(
      path.join(artifactDirectory, records[0].evidenceReference),
      bodyBearingContent,
      "utf8",
    );
    await writeFile(
      evidencePath,
      `${bodyBearingRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await assert.rejects(
      validateAgentWakeEvidenceManifest(evidencePath, artifactDirectory),
      expectCode("artifact-content-invalid"),
    );
    await writeFile(
      path.join(artifactDirectory, records[0].evidenceReference),
      artifactContent(records[0]),
    );
    await writeFile(
      evidencePath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const reusedReference = structuredClone(records);
    reusedReference[1].evidenceReference = reusedReference[0].evidenceReference;
    reusedReference[1].evidenceDigestSha256 = reusedReference[0].evidenceDigestSha256;
    await writeFile(
      evidencePath,
      `${reusedReference.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await assert.rejects(
      validateAgentWakeEvidenceManifest(evidencePath, artifactDirectory),
      expectCode("artifact-reference-reused"),
    );
    await writeFile(
      evidencePath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const changedArtifact = path.join(artifactDirectory, records[0].evidenceReference);
    await writeFile(changedArtifact, "changed\n", "utf8");
    await assert.rejects(
      validateAgentWakeEvidenceManifest(evidencePath, artifactDirectory),
      expectCode("artifact-digest-mismatch"),
    );
    await writeFile(changedArtifact, artifactContent(records[0]));
    await chmod(evidencePath, 0o622);
    await assert.rejects(
      validateAgentWakeEvidenceManifest(evidencePath, artifactDirectory),
      expectCode("evidence-file-accessible-by-others"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
