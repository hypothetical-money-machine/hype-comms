import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";

import {
  agentWakeIdSchema,
  agentWakeSignalSchema,
  entityIdSchema,
  isoDateTimeSchema,
  sequenceSchema,
} from "@hype-comms/contracts";
import { deriveAgentWakeId } from "@hype-comms/contracts/wake-node";
import { z } from "zod";

import type {
  AgentWakeInboxStore,
  AgentWakeStoreMutation,
  StoredAgentWakeEnrollment,
} from "./agent-wake-broker";
import { agentWakeApiOriginSchema } from "./agent-wake-validation";
import {
  atomicWrite,
  readPrivateBoundedUtf8File,
  syncDirectoryStrict,
  type PrivateFileReadResult,
  type SyncDirectory,
} from "./preference-file";

export const AGENT_WAKE_STORE_MAX_BYTES = 4 * 1_024 * 1_024;
export const AGENT_WAKE_STORE_MAX_QUEUE_ITEMS = 10_000;
export const AGENT_WAKE_STORE_MAX_COMPLETIONS = 10_000;

const opaqueHandleSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Opaque handles cannot contain controls");
const safeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = safeIntegerSchema.min(1);
const providerRetryCodeSchema = z.enum([
  "provider-overloaded",
  "provider-rate-limited",
  "provider-unavailable",
]);
const repairCodeSchema = z.enum([
  "provider-authentication-required",
  "provider-contract-invalid",
  "provider-outcome-ambiguous",
  "provider-rejected",
  "provider-retry-exhausted",
  "source-authentication-required",
  "source-client-replay-overflow",
  "source-cursor-expired",
  "source-record-invalid",
  "source-scope-invalid",
  "source-server-reset",
]);
const sourceRepairCodeSchema = z.enum([
  "source-authentication-required",
  "source-client-replay-overflow",
  "source-cursor-expired",
  "source-record-invalid",
  "source-scope-invalid",
  "source-server-reset",
]);

const storedItemSchema = z
  .object({
    wake: agentWakeSignalSchema,
    sourceCursor: sequenceSchema,
    enqueuedAt: safeIntegerSchema,
    phase: z.enum(["queued", "delivering", "retry-wait", "blocked"]),
    attempts: safeIntegerSchema,
    nextAttemptAt: safeIntegerSchema.nullable(),
    lastRetryCode: providerRetryCodeSchema.nullable(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.sourceCursor !== item.wake.workspaceSequence) {
      context.addIssue({
        code: "custom",
        path: ["sourceCursor"],
        message: "Stored wake cursor must match the signal",
      });
    }
    if (item.phase === "retry-wait") {
      if (item.attempts === 0 || item.nextAttemptAt === null || item.lastRetryCode === null) {
        context.addIssue({ code: "custom", message: "Retry state is incomplete" });
      }
    } else if (item.nextAttemptAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["nextAttemptAt"],
        message: "Only retry-wait items may have a retry deadline",
      });
    }
    if ((item.phase === "delivering" || item.phase === "blocked") && item.attempts === 0) {
      context.addIssue({ code: "custom", message: "Claimed wake must record an attempt" });
    }
  });

const completionSchema = z
  .object({
    wakeId: agentWakeIdSchema,
    conversationId: entityIdSchema,
    messageId: entityIdSchema,
    reason: z.enum(["direct_message", "verified_mention"]),
    occurredAt: isoDateTimeSchema,
    sourceCursor: sequenceSchema,
    attempt: positiveSafeIntegerSchema,
    brokerDurableAt: safeIntegerSchema,
    disposition: z.enum(["accepted", "duplicate", "coalesced"]),
    providerReceiptId: opaqueHandleSchema,
    completedAt: safeIntegerSchema,
  })
  .strict()
  .superRefine((completion, context) => {
    if (completion.completedAt < completion.brokerDurableAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Completion cannot precede durable enqueue",
      });
    }
  });

const operatorActionSchema = z
  .object({
    actionId: agentWakeIdSchema,
    action: z.enum([
      "confirm-accepted",
      "confirm-coalesced",
      "confirm-duplicate",
      "provider-retry",
      "resume",
      "source-reset-from-now",
    ]),
    repairCode: repairCodeSchema.nullable(),
    repairOccurredAt: safeIntegerSchema.nullable(),
    wakeId: agentWakeIdSchema.nullable(),
    evidenceReference: opaqueHandleSchema,
    occurredAt: safeIntegerSchema,
  })
  .strict();

const storedAgentWakeEnrollmentSchema = z
  .object({
    version: z.literal(1),
    revision: positiveSafeIntegerSchema,
    enrollmentId: opaqueHandleSchema,
    identity: z
      .object({
        apiOrigin: agentWakeApiOriginSchema,
        workspaceId: entityIdSchema,
        agentUserId: entityIdSchema,
      })
      .strict(),
    credentialHandle: opaqueHandleSchema,
    provider: z
      .object({ adapterId: opaqueHandleSchema, targetHandle: opaqueHandleSchema })
      .strict(),
    cursor: sequenceSchema,
    runState: z.enum(["stopped", "running", "paused-capacity"]),
    queue: z.array(storedItemSchema).max(AGENT_WAKE_STORE_MAX_QUEUE_ITEMS),
    completions: z.array(completionSchema).max(AGENT_WAKE_STORE_MAX_COMPLETIONS),
    operatorActions: z.array(operatorActionSchema).max(AGENT_WAKE_STORE_MAX_COMPLETIONS),
    repair: z
      .object({
        code: repairCodeSchema,
        wakeId: agentWakeIdSchema.nullable(),
        occurredAt: safeIntegerSchema,
        deferredSourceRepair: z
          .object({
            code: sourceRepairCodeSchema,
            wakeId: agentWakeIdSchema.nullable(),
            occurredAt: safeIntegerSchema,
          })
          .strict()
          .nullable()
          .default(null),
      })
      .strict()
      .nullable(),
    sourceRetry: z
      .object({
        code: z.literal("source-unavailable"),
        attempt: positiveSafeIntegerSchema,
        nextAttemptAt: safeIntegerSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    const seenWakeIds = new Set<string>();
    for (const [index, item] of state.queue.entries()) {
      if (
        item.wake.workspaceId !== state.identity.workspaceId ||
        item.wake.agentUserId !== state.identity.agentUserId
      ) {
        context.addIssue({
          code: "custom",
          path: ["queue", index, "wake"],
          message: "Stored wake is outside the enrollment scope",
        });
      }
      const expectedWakeId = deriveAgentWakeId(item.wake);
      if (item.wake.wakeId !== expectedWakeId) {
        context.addIssue({
          code: "custom",
          path: ["queue", index, "wake", "wakeId"],
          message: "Stored wake ID does not match its logical key",
        });
      }
      if (BigInt(item.sourceCursor) > BigInt(state.cursor)) {
        context.addIssue({
          code: "custom",
          path: ["queue", index, "sourceCursor"],
          message: "Stored wake is ahead of the enrollment cursor",
        });
      }
      if (seenWakeIds.has(item.wake.wakeId)) {
        context.addIssue({
          code: "custom",
          path: ["queue", index, "wake", "wakeId"],
          message: "Stored wake IDs must be unique",
        });
      }
      seenWakeIds.add(item.wake.wakeId);
      if (index > 0 && item.phase !== "queued") {
        context.addIssue({
          code: "custom",
          path: ["queue", index, "phase"],
          message: "Only the FIFO head may be claimed, waiting, or blocked",
        });
      }
      if (index > 0 && BigInt(item.sourceCursor) <= BigInt(state.queue[index - 1]!.sourceCursor)) {
        context.addIssue({
          code: "custom",
          path: ["queue", index, "sourceCursor"],
          message: "Stored wake cursors must increase in FIFO order",
        });
      }
    }
    for (const [index, completion] of state.completions.entries()) {
      if (seenWakeIds.has(completion.wakeId)) {
        context.addIssue({
          code: "custom",
          path: ["completions", index, "wakeId"],
          message: "Wake IDs must not repeat across the inbox and completion ledger",
        });
      }
      seenWakeIds.add(completion.wakeId);
      const expectedWakeId = deriveAgentWakeId({
        workspaceId: state.identity.workspaceId,
        agentUserId: state.identity.agentUserId,
        messageId: completion.messageId,
      });
      if (completion.wakeId !== expectedWakeId) {
        context.addIssue({
          code: "custom",
          path: ["completions", index, "wakeId"],
          message: "Completion wake ID does not match its logical key",
        });
      }
      if (BigInt(completion.sourceCursor) > BigInt(state.cursor)) {
        context.addIssue({
          code: "custom",
          path: ["completions", index, "sourceCursor"],
          message: "Completion is ahead of the enrollment cursor",
        });
      }
      if (
        index > 0 &&
        BigInt(completion.sourceCursor) <= BigInt(state.completions[index - 1]!.sourceCursor)
      ) {
        context.addIssue({
          code: "custom",
          path: ["completions", index, "sourceCursor"],
          message: "Completion cursors must increase in delivery order",
        });
      }
    }
    const lastCompletion = state.completions.at(-1);
    const firstQueued = state.queue[0];
    if (
      lastCompletion !== undefined &&
      firstQueued !== undefined &&
      BigInt(firstQueued.sourceCursor) <= BigInt(lastCompletion.sourceCursor)
    ) {
      context.addIssue({
        code: "custom",
        path: ["queue", 0, "sourceCursor"],
        message: "Queued wakes must follow completed wakes",
      });
    }
    const seenActionIds = new Set<string>();
    for (const [index, action] of state.operatorActions.entries()) {
      const validRepairClass =
        action.action === "resume"
          ? action.repairCode === null && action.repairOccurredAt === null && action.wakeId === null
          : action.action === "source-reset-from-now"
            ? action.repairCode?.startsWith("source-") === true && action.repairOccurredAt !== null
            : action.repairCode?.startsWith("provider-") === true &&
              action.repairOccurredAt !== null &&
              action.wakeId !== null;
      if (!validRepairClass) {
        context.addIssue({
          code: "custom",
          path: ["operatorActions", index, "repairCode"],
          message: "Operator action does not match its repair class",
        });
      }
      if (seenActionIds.has(action.actionId)) {
        context.addIssue({
          code: "custom",
          path: ["operatorActions", index, "actionId"],
          message: "Operator action IDs must be unique",
        });
      }
      seenActionIds.add(action.actionId);
      if (index > 0 && action.occurredAt < state.operatorActions[index - 1]!.occurredAt) {
        context.addIssue({
          code: "custom",
          path: ["operatorActions", index, "occurredAt"],
          message: "Operator audit records must remain chronological",
        });
      }
    }
    if (state.repair !== null && state.runState !== "stopped") {
      context.addIssue({
        code: "custom",
        path: ["runState"],
        message: "An enrollment requiring repair must be stopped",
      });
    }
    if (state.repair !== null && state.sourceRetry !== null) {
      context.addIssue({
        code: "custom",
        path: ["sourceRetry"],
        message: "A repair state cannot also be retrying its source",
      });
    }
    if (
      state.repair !== null &&
      state.repair.deferredSourceRepair !== null &&
      !state.repair.code.startsWith("provider-")
    ) {
      context.addIssue({
        code: "custom",
        path: ["repair", "deferredSourceRepair"],
        message: "Only a provider repair may defer a source repair",
      });
    }
    const blockedItems = state.queue.filter((item) => item.phase === "blocked");
    if (state.repair?.code.startsWith("provider-") === true) {
      const head = state.queue[0];
      if (
        state.repair.wakeId === null ||
        head === undefined ||
        head.phase !== "blocked" ||
        head.wake.wakeId !== state.repair.wakeId ||
        blockedItems.length !== 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["repair"],
          message: "Provider repair must identify exactly the blocked FIFO head",
        });
      }
    } else if (blockedItems.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["queue"],
        message: "A blocked wake requires matching provider repair",
      });
    }
  });

export class AgentWakeFileStoreError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: "invalid-enrollment" | "invalid-state" | "store-unavailable") {
    super(`Agent wake file store failed: ${code}`);
    this.name = "AgentWakeFileStoreError";
    this.retryable = code === "store-unavailable";
  }
}

function parseEnrollmentId(enrollmentId: string): string {
  const parsed = opaqueHandleSchema.safeParse(enrollmentId);
  if (!parsed.success) throw new AgentWakeFileStoreError("invalid-enrollment");
  return parsed.data;
}

function parseState(value: unknown, enrollmentId: string): StoredAgentWakeEnrollment {
  const parsed = storedAgentWakeEnrollmentSchema.safeParse(value);
  if (!parsed.success || parsed.data.enrollmentId !== enrollmentId) {
    throw new AgentWakeFileStoreError("invalid-state");
  }
  return parsed.data;
}

/**
 * Atomic, private, process-local durable storage for body-free wake inboxes.
 *
 * Filenames are hashes of enrollment handles, and callers receive only stable errors: neither a
 * malformed record nor an opaque credential/target handle can be copied into logs by this class.
 */
export class AgentWakeFileStore implements AgentWakeInboxStore {
  readonly #directory: string;
  readonly #readPrivateFile: (filePath: string, maxBytes: number) => Promise<PrivateFileReadResult>;
  readonly #syncDirectory: SyncDirectory;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: {
    readonly userDataPath: string;
    readonly readPrivateFile?: (
      filePath: string,
      maxBytes: number,
    ) => Promise<PrivateFileReadResult>;
    readonly syncDirectory?: SyncDirectory;
  }) {
    this.#directory = path.join(options.userDataPath, "agent-wake");
    this.#readPrivateFile = options.readPrivateFile ?? readPrivateBoundedUtf8File;
    this.#syncDirectory = options.syncDirectory ?? syncDirectoryStrict;
  }

  read(enrollmentId: string): Promise<StoredAgentWakeEnrollment | null> {
    return this.#read(parseEnrollmentId(enrollmentId));
  }

  async transaction<T>(
    enrollmentId: string,
    mutate: (current: StoredAgentWakeEnrollment | null) => AgentWakeStoreMutation<T>,
  ): Promise<T> {
    const canonicalId = parseEnrollmentId(enrollmentId);
    const previous = this.#tails.get(canonicalId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(canonicalId, tail);
    await previous;
    try {
      const current = await this.#read(canonicalId);
      const mutation = mutate(current);
      if (mutation.state === null) {
        if (current !== null) {
          await rm(this.#filePath(canonicalId), { force: true });
          await this.#syncDirectory(this.#directory);
        }
        return mutation.result;
      }

      const state = parseState(mutation.state, canonicalId);
      const source = `${JSON.stringify(state)}\n`;
      if (Buffer.byteLength(source, "utf8") > AGENT_WAKE_STORE_MAX_BYTES) {
        throw new AgentWakeFileStoreError("invalid-state");
      }
      try {
        await atomicWrite(this.#filePath(canonicalId), source, this.#syncDirectory, {
          requireDirectorySync: true,
        });
      } catch (error) {
        if (error instanceof AgentWakeFileStoreError) throw error;
        throw new AgentWakeFileStoreError("store-unavailable");
      }
      return mutation.result;
    } finally {
      release?.();
      if (this.#tails.get(canonicalId) === tail) this.#tails.delete(canonicalId);
    }
  }

  async #read(enrollmentId: string): Promise<StoredAgentWakeEnrollment | null> {
    const filePath = this.#filePath(enrollmentId);
    let metadata;
    try {
      metadata = await lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AgentWakeFileStoreError("store-unavailable");
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0 ||
      metadata.size > AGENT_WAKE_STORE_MAX_BYTES ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new AgentWakeFileStoreError("invalid-state");
    }
    const source = await this.#readPrivateFile(filePath, AGENT_WAKE_STORE_MAX_BYTES);
    if (source.status === "unavailable") {
      throw new AgentWakeFileStoreError("store-unavailable");
    }
    if (source.status === "invalid") throw new AgentWakeFileStoreError("invalid-state");
    try {
      return parseState(JSON.parse(source.value) as unknown, enrollmentId);
    } catch (error) {
      if (error instanceof AgentWakeFileStoreError) throw error;
      throw new AgentWakeFileStoreError("invalid-state");
    }
  }

  #filePath(enrollmentId: string): string {
    const key = createHash("sha256").update(enrollmentId, "utf8").digest("hex");
    return path.join(this.#directory, `${key}.json`);
  }
}
