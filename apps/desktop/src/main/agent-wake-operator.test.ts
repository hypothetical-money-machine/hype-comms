import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentWakeBrokerError,
  type AgentWakeBrokerEvidence,
  type AgentWakeBrokerStatus,
} from "./agent-wake-broker";
import {
  AgentWakeOperatorError,
  applyAgentWakeOperatorRequest,
  loadAgentWakeOperatorRequest,
  resolveAgentWakeOperatorRequestPath,
  writeAgentWakeOperatorResponse,
  type AgentWakeOperatorRequest,
} from "./agent-wake-operator";

const ENROLLMENT_ID = "grok-bot-pilot";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_USER_ID = "10000000-0000-4000-8000-000000000002";
const REQUEST_ID = "a".repeat(64);
const WAKE_ID = "b".repeat(64);
const REPAIR_OCCURRED_AT = 1_800_000_000_000;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function status(): AgentWakeBrokerStatus {
  return {
    enrollmentId: ENROLLMENT_ID,
    workspaceId: WORKSPACE_ID,
    agentUserId: AGENT_USER_ID,
    adapterId: "agent-runtime-test",
    cursor: "42",
    phase: "running",
    queueDepth: 0,
    activeWakeId: null,
    retry: null,
    repair: null,
    lastCompletion: null,
  };
}

function evidence(): AgentWakeBrokerEvidence {
  return {
    version: 1,
    type: "agent.wake.broker_evidence",
    enrollmentId: ENROLLMENT_ID,
    workspaceId: WORKSPACE_ID,
    agentUserId: AGENT_USER_ID,
    adapterId: "agent-runtime-test",
    cursor: "42",
    completions: [],
    operatorActions: [],
  };
}

function broker() {
  return {
    status: vi.fn(async () => status()),
    evidence: vi.fn(async () => evidence()),
    resolveProviderRepair: vi.fn(async () => status()),
    resetSourceFromNow: vi.fn(async () => status()),
    resume: vi.fn(async () => status()),
  };
}

async function fixture(request: AgentWakeOperatorRequest) {
  const directory = await mkdtemp(path.join(tmpdir(), "hype-wake-operator-"));
  directories.push(directory);
  const requestPath = path.join(directory, "request.json");
  await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  await chmod(requestPath, 0o600);
  return { directory, requestPath };
}

describe("agent wake operator request", () => {
  it("resolves only a compiled-in absolute private-request path", () => {
    expect(
      resolveAgentWakeOperatorRequestPath({
        compiledIn: true,
        env: { HYPE_COMMS_AGENT_WAKE_OPERATOR_REQUEST: "/private/operator.json" },
      }),
    ).toBe("/private/operator.json");
    expect(resolveAgentWakeOperatorRequestPath({ compiledIn: true, env: {} })).toBeNull();
    expect(() =>
      resolveAgentWakeOperatorRequestPath({
        compiledIn: false,
        env: { HYPE_COMMS_AGENT_WAKE_OPERATOR_REQUEST: "/private/operator.json" },
      }),
    ).toThrow(new AgentWakeOperatorError("not-compiled-in"));
  });

  it("loads a strict 0600 request and rejects extra credential-like fields", async () => {
    const request = {
      version: 1,
      requestId: REQUEST_ID,
      action: "status",
    } as const;
    const { requestPath, directory } = await fixture(request);
    await expect(loadAgentWakeOperatorRequest({ filePath: requestPath })).resolves.toEqual(request);

    await chmod(requestPath, 0o644);
    await expect(loadAgentWakeOperatorRequest({ filePath: requestPath })).rejects.toMatchObject({
      code: "operator-request-invalid",
    });
    await writeFile(requestPath, JSON.stringify({ ...request, token: "must-not-be-accepted" }), {
      mode: 0o600,
    });
    await chmod(requestPath, 0o600);
    await expect(loadAgentWakeOperatorRequest({ filePath: requestPath })).rejects.toMatchObject({
      code: "operator-request-invalid",
    });
    expect(directory).not.toBe("");
  });

  it("exports status without invoking a repair action", async () => {
    const fake = broker();
    const response = await applyAgentWakeOperatorRequest({
      broker: fake,
      enrollmentId: ENROLLMENT_ID,
      request: {
        version: 1,
        requestId: REQUEST_ID,
        action: "status",
      },
    });

    expect(response).toMatchObject({ ok: true, errorCode: null, status: { phase: "running" } });
    expect(fake.resolveProviderRepair).not.toHaveBeenCalled();
    expect(fake.resume).not.toHaveBeenCalled();
  });

  it("records an idempotent provider decision and a derived resume action", async () => {
    const fake = broker();
    const response = await applyAgentWakeOperatorRequest({
      broker: fake,
      enrollmentId: ENROLLMENT_ID,
      request: {
        version: 1,
        requestId: REQUEST_ID,
        action: "confirm-accepted",
        evidenceReference: "runtime-activity-42",
        expectedRepairCode: "provider-outcome-ambiguous",
        expectedRepairOccurredAt: REPAIR_OCCURRED_AT,
        expectedWakeId: WAKE_ID,
        providerReceiptId: "runtime:receipt-42",
      },
    });
    const expectedResumeId = createHash("sha256")
      .update(JSON.stringify(["hype-wake-operator-resume-v1", REQUEST_ID]), "utf8")
      .digest("hex");

    expect(fake.resolveProviderRepair).toHaveBeenCalledWith({
      enrollmentId: ENROLLMENT_ID,
      action: "confirm-accepted",
      actionId: REQUEST_ID,
      evidenceReference: "runtime-activity-42",
      expectedRepairCode: "provider-outcome-ambiguous",
      expectedRepairOccurredAt: REPAIR_OCCURRED_AT,
      expectedWakeId: WAKE_ID,
      providerReceiptId: "runtime:receipt-42",
    });
    expect(fake.resume).toHaveBeenCalledWith({
      enrollmentId: ENROLLMENT_ID,
      actionId: expectedResumeId,
      evidenceReference: "runtime-activity-42",
    });
    expect(response).toMatchObject({ ok: true, evidence: { type: "agent.wake.broker_evidence" } });
  });

  it("reports a provider retry as successful when it promotes a deferred source repair", async () => {
    const fake = broker();
    const sourceRepairStatus: AgentWakeBrokerStatus = {
      ...status(),
      phase: "blocked-repair",
      queueDepth: 1,
      activeWakeId: WAKE_ID,
      repair: {
        code: "source-cursor-expired",
        wakeId: null,
        occurredAt: REPAIR_OCCURRED_AT + 1,
        deferredSourceRepair: null,
      },
    };
    fake.resolveProviderRepair.mockResolvedValueOnce(sourceRepairStatus);
    fake.resume.mockRejectedValueOnce(new AgentWakeBrokerError("repair-action-invalid"));

    const response = await applyAgentWakeOperatorRequest({
      broker: fake,
      enrollmentId: ENROLLMENT_ID,
      request: {
        version: 1,
        requestId: REQUEST_ID,
        action: "provider-retry",
        evidenceReference: "provider-proved-not-accepted",
        expectedRepairCode: "provider-outcome-ambiguous",
        expectedRepairOccurredAt: REPAIR_OCCURRED_AT,
        expectedWakeId: WAKE_ID,
      },
    });

    expect(response).toMatchObject({
      ok: true,
      errorCode: null,
      status: {
        phase: "blocked-repair",
        repair: { code: "source-cursor-expired" },
      },
    });
    expect(fake.resume).not.toHaveBeenCalled();
  });

  it("writes a private, body-free response atomically", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hype-wake-operator-response-"));
    directories.push(directory);
    const responseDirectory = path.join(directory, "responses");
    const response = await applyAgentWakeOperatorRequest({
      broker: broker(),
      enrollmentId: ENROLLMENT_ID,
      request: {
        version: 1,
        requestId: REQUEST_ID,
        action: "evidence",
      },
    });

    const responsePath = await writeAgentWakeOperatorResponse(responseDirectory, response);

    expect(responsePath).toBe(path.join(responseDirectory, `${REQUEST_ID}.json`));
    expect((await lstat(responseDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(responsePath)).mode & 0o777).toBe(0o600);
    const source = await readFile(responsePath, "utf8");
    expect(JSON.parse(source)).toEqual(response);
    expect(source).not.toMatch(/body|history|credential|token|prompt/iu);
  });
});
