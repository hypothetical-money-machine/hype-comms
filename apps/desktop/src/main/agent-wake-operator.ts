import { createHash } from "node:crypto";
import path from "node:path";

import { agentWakeIdSchema } from "@hype-comms/contracts";
import { z } from "zod";

import type {
  AgentWakeBroker,
  AgentWakeBrokerEvidence,
  AgentWakeBrokerStatus,
} from "./agent-wake-broker";
import { atomicWrite, readPrivateBoundedUtf8File, syncDirectoryStrict } from "./preference-file";

export const AGENT_WAKE_OPERATOR_REQUEST_ENV = "HYPE_COMMS_AGENT_WAKE_OPERATOR_REQUEST";
export const AGENT_WAKE_OPERATOR_REQUEST_MAX_BYTES = 64 * 1_024;

const absoluteFilePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0") && path.isAbsolute(value), {
    message: "Expected an absolute file path",
  })
  .refine((value) => path.resolve(value) !== path.parse(path.resolve(value)).root, {
    message: "A filesystem root is not a file path",
  });
const evidenceReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Control characters are not allowed");
const providerReceiptIdSchema = evidenceReferenceSchema;
const repairOccurredAtSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const providerRepairCodeSchema = z.enum([
  "provider-authentication-required",
  "provider-contract-invalid",
  "provider-outcome-ambiguous",
  "provider-rejected",
  "provider-retry-exhausted",
]);
const sourceRepairCodeSchema = z.enum([
  "source-authentication-required",
  "source-client-replay-overflow",
  "source-cursor-expired",
  "source-record-invalid",
  "source-scope-invalid",
  "source-server-reset",
]);
const requestBase = {
  version: z.literal(1),
  requestId: agentWakeIdSchema,
};

export const agentWakeOperatorRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...requestBase, action: z.literal("status") }).strict(),
  z.object({ ...requestBase, action: z.literal("evidence") }).strict(),
  z
    .object({
      ...requestBase,
      action: z.literal("provider-retry"),
      evidenceReference: evidenceReferenceSchema,
      expectedRepairCode: providerRepairCodeSchema,
      expectedRepairOccurredAt: repairOccurredAtSchema,
      expectedWakeId: agentWakeIdSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      action: z.enum(["confirm-accepted", "confirm-duplicate", "confirm-coalesced"]),
      evidenceReference: evidenceReferenceSchema,
      expectedRepairCode: providerRepairCodeSchema,
      expectedRepairOccurredAt: repairOccurredAtSchema,
      expectedWakeId: agentWakeIdSchema,
      providerReceiptId: providerReceiptIdSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      action: z.literal("source-reset-from-now"),
      evidenceReference: evidenceReferenceSchema,
      expectedRepairCode: sourceRepairCodeSchema,
      expectedRepairOccurredAt: repairOccurredAtSchema,
      expectedWakeId: agentWakeIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      action: z.literal("resume"),
      evidenceReference: evidenceReferenceSchema,
    })
    .strict(),
]);

export type AgentWakeOperatorRequest = z.infer<typeof agentWakeOperatorRequestSchema>;

export type AgentWakeOperatorResponse = {
  readonly version: 1;
  readonly type: "agent.wake.operator_response";
  readonly requestId: string;
  readonly action: AgentWakeOperatorRequest["action"];
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly status: AgentWakeBrokerStatus | null;
  readonly evidence: AgentWakeBrokerEvidence | null;
};

interface AgentWakeOperatorBroker {
  status(enrollmentId: string): ReturnType<AgentWakeBroker["status"]>;
  evidence(enrollmentId: string): ReturnType<AgentWakeBroker["evidence"]>;
  resolveProviderRepair(
    input: Parameters<AgentWakeBroker["resolveProviderRepair"]>[0],
  ): ReturnType<AgentWakeBroker["resolveProviderRepair"]>;
  resetSourceFromNow(
    input: Parameters<AgentWakeBroker["resetSourceFromNow"]>[0],
  ): ReturnType<AgentWakeBroker["resetSourceFromNow"]>;
  resume(input: Parameters<AgentWakeBroker["resume"]>[0]): ReturnType<AgentWakeBroker["resume"]>;
}

export class AgentWakeOperatorError extends Error {
  constructor(
    readonly code:
      | "operator-request-invalid"
      | "operator-request-unavailable"
      | "operator-response-unavailable"
      | "not-compiled-in",
  ) {
    super(`Agent wake operator request failed: ${code}`);
    this.name = "AgentWakeOperatorError";
  }
}

export function resolveAgentWakeOperatorRequestPath(options: {
  readonly compiledIn: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): string | null {
  const configured = options.env[AGENT_WAKE_OPERATOR_REQUEST_ENV]?.trim() ?? "";
  if (!options.compiledIn) {
    if (configured !== "") throw new AgentWakeOperatorError("not-compiled-in");
    return null;
  }
  if (configured === "") return null;
  const parsed = absoluteFilePathSchema.safeParse(configured);
  if (!parsed.success) throw new AgentWakeOperatorError("operator-request-invalid");
  return path.resolve(parsed.data);
}

export async function loadAgentWakeOperatorRequest(options: {
  readonly filePath: string;
  readonly platform?: NodeJS.Platform;
  readonly currentUid?: number | undefined;
}): Promise<AgentWakeOperatorRequest> {
  const source = await readPrivateBoundedUtf8File(
    options.filePath,
    AGENT_WAKE_OPERATOR_REQUEST_MAX_BYTES,
    { platform: options.platform, currentUid: options.currentUid },
  );
  if (source.status === "unavailable") {
    throw new AgentWakeOperatorError("operator-request-unavailable");
  }
  if (source.status === "invalid") {
    throw new AgentWakeOperatorError("operator-request-invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(source.value) as unknown;
  } catch {
    throw new AgentWakeOperatorError("operator-request-invalid");
  }
  const parsed = agentWakeOperatorRequestSchema.safeParse(value);
  if (!parsed.success) throw new AgentWakeOperatorError("operator-request-invalid");
  return parsed.data;
}

function resumeActionId(requestId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["hype-wake-operator-resume-v1", requestId]), "utf8")
    .digest("hex");
}

function stableErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "operator-action-failed";
}

function responseBase(
  request: AgentWakeOperatorRequest,
): Pick<AgentWakeOperatorResponse, "version" | "type" | "requestId" | "action"> {
  return {
    version: 1,
    type: "agent.wake.operator_response",
    requestId: request.requestId,
    action: request.action,
  };
}

/** Applies one idempotent, private startup request and returns only body-free operator data. */
export async function applyAgentWakeOperatorRequest(options: {
  readonly broker: AgentWakeOperatorBroker;
  readonly enrollmentId: string;
  readonly request: AgentWakeOperatorRequest;
}): Promise<AgentWakeOperatorResponse> {
  const { broker, enrollmentId, request } = options;
  try {
    if (request.action === "status") {
      const status = await broker.status(enrollmentId);
      return {
        ...responseBase(request),
        ok: status !== null,
        errorCode: status === null ? "enrollment-not-found" : null,
        status,
        evidence: null,
      };
    }
    if (request.action === "evidence") {
      const evidence = await broker.evidence(enrollmentId);
      const status = await broker.status(enrollmentId);
      return {
        ...responseBase(request),
        ok: evidence !== null && status !== null,
        errorCode: evidence === null || status === null ? "enrollment-not-found" : null,
        status,
        evidence,
      };
    }

    if (request.action === "provider-retry") {
      await broker.resolveProviderRepair({
        enrollmentId,
        action: "retry",
        actionId: request.requestId,
        evidenceReference: request.evidenceReference,
        expectedRepairCode: request.expectedRepairCode,
        expectedRepairOccurredAt: request.expectedRepairOccurredAt,
        expectedWakeId: request.expectedWakeId,
      });
    } else if (
      request.action === "confirm-accepted" ||
      request.action === "confirm-duplicate" ||
      request.action === "confirm-coalesced"
    ) {
      await broker.resolveProviderRepair({
        enrollmentId,
        action: request.action,
        actionId: request.requestId,
        evidenceReference: request.evidenceReference,
        expectedRepairCode: request.expectedRepairCode,
        expectedRepairOccurredAt: request.expectedRepairOccurredAt,
        expectedWakeId: request.expectedWakeId,
        providerReceiptId: request.providerReceiptId,
      });
    } else if (request.action === "source-reset-from-now") {
      await broker.resetSourceFromNow({
        enrollmentId,
        actionId: request.requestId,
        evidenceReference: request.evidenceReference,
        expectedRepairCode: request.expectedRepairCode,
        expectedRepairOccurredAt: request.expectedRepairOccurredAt,
        expectedWakeId: request.expectedWakeId,
      });
    }

    const status = await broker.resume({
      enrollmentId,
      actionId: request.action === "resume" ? request.requestId : resumeActionId(request.requestId),
      evidenceReference: request.evidenceReference,
    });
    return {
      ...responseBase(request),
      ok: true,
      errorCode: null,
      status,
      evidence: await broker.evidence(enrollmentId),
    };
  } catch (error) {
    return {
      ...responseBase(request),
      ok: false,
      errorCode: stableErrorCode(error),
      status: await broker.status(enrollmentId).catch(() => null),
      evidence: null,
    };
  }
}

export async function writeAgentWakeOperatorResponse(
  responseDirectory: string,
  response: AgentWakeOperatorResponse,
): Promise<string> {
  const parsedDirectory = absoluteFilePathSchema.safeParse(responseDirectory);
  if (!parsedDirectory.success) {
    throw new AgentWakeOperatorError("operator-response-unavailable");
  }
  const responsePath = path.join(path.resolve(parsedDirectory.data), `${response.requestId}.json`);
  try {
    await atomicWrite(
      path.resolve(responsePath),
      `${JSON.stringify(response)}\n`,
      syncDirectoryStrict,
      { requireDirectorySync: true },
    );
  } catch {
    throw new AgentWakeOperatorError("operator-response-unavailable");
  }
  return responsePath;
}
