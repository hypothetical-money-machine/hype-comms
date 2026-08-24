import { z } from "zod";

import { entityIdSchema, isoDateTimeSchema, sequenceSchema } from "./common.js";
import type { EntityId } from "./common.js";
import { conversationKindSchema, type ConversationKind } from "./entities.js";
import { realtimeDeliverySemanticsSchema } from "./realtime.js";
import type { ProductRealtimeEvent } from "./workspace.js";

/** Domain separator for the stable wake-id preimage. */
export const AGENT_WAKE_KEY_DOMAIN = "hype-wake-v1";
/** Hard wire and query bound for the body-free wake bootstrap. */
export const AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS = 5_000;

export const agentWakeBootstrapConversationSchema = z
  .object({
    conversationId: entityIdSchema,
    kind: conversationKindSchema,
  })
  .strict()
  .readonly();

/**
 * Minimal future-only projection used before an agent opens realtime wake delivery. Message,
 * member, workspace-detail, and conversation-summary fields are deliberately absent.
 */
export const agentWakeBootstrapResponseSchema = z
  .object({
    agentUserId: entityIdSchema,
    workspaceId: entityIdSchema,
    highWaterCursor: sequenceSchema,
    conversations: z
      .array(agentWakeBootstrapConversationSchema)
      .max(AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS),
  })
  .strict()
  .readonly();

export const agentWakeReasonSchema = z.enum(["direct_message", "verified_mention"]);

/**
 * The complete logical identity of one wake. Consumers SHA-256 the UTF-8 bytes returned by
 * {@link encodeAgentWakeKeyInput} and use the lowercase hexadecimal digest as `wakeId`.
 *
 * Keeping hashing outside this package makes the wire contract usable in Node, browsers, and
 * other runtimes without importing a platform crypto implementation.
 */
export const agentWakeKeyInputSchema = z
  .object({
    version: z.literal(1),
    workspaceId: entityIdSchema,
    agentUserId: entityIdSchema,
    messageId: entityIdSchema,
  })
  .strict()
  .readonly();

export const agentWakeIdSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest");

const agentWakeCandidateShape = {
  version: z.literal(1),
  type: z.literal("agent.wake"),
  delivery: realtimeDeliverySemanticsSchema,
  eventId: entityIdSchema,
  workspaceSequence: sequenceSchema,
  workspaceId: entityIdSchema,
  agentUserId: entityIdSchema,
  conversationId: entityIdSchema,
  messageId: entityIdSchema,
  threadRootId: entityIdSchema.nullable(),
  occurredAt: isoDateTimeSchema,
  reason: agentWakeReasonSchema,
};

/** Eligible wake metadata before the runtime-specific SHA-256 operation. */
export const agentWakeCandidateSchema = z.object(agentWakeCandidateShape).strict().readonly();

/** Body-free provider-neutral signal accepted by a wake target. */
export const agentWakeSignalSchema = z
  .object({
    ...agentWakeCandidateShape,
    wakeId: agentWakeIdSchema,
  })
  .strict()
  .readonly();

/** Body-free durable progress shared by Wake realtime scan control and CLI stdout. */
export const agentWakeCheckpointSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("agent.wake.checkpoint"),
    workspaceId: entityIdSchema,
    agentUserId: entityIdSchema,
    cursor: sequenceSchema,
  })
  .strict()
  .readonly();

export const agentWakeRepairReasonSchema = z.enum([
  "cursor_expired",
  "server_reset",
  "client_replay_overflow",
]);

export const agentWakeRepairRequiredSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("agent.wake.repair_required"),
    workspaceId: entityIdSchema,
    agentUserId: entityIdSchema,
    cursor: sequenceSchema,
    reason: agentWakeRepairReasonSchema,
  })
  .strict()
  .readonly();

/** Newline-delimited JSON and stdout consumers validate every record through this union. */
export const agentWakeStreamRecordSchema = z.discriminatedUnion("type", [
  agentWakeSignalSchema,
  agentWakeCheckpointSchema,
  agentWakeRepairRequiredSchema,
]);

export type AgentWakeReason = z.infer<typeof agentWakeReasonSchema>;
export type AgentWakeBootstrapConversation = z.infer<typeof agentWakeBootstrapConversationSchema>;
export type AgentWakeBootstrapResponse = z.infer<typeof agentWakeBootstrapResponseSchema>;
export type AgentWakeKeyInput = z.infer<typeof agentWakeKeyInputSchema>;
export type AgentWakeId = z.infer<typeof agentWakeIdSchema>;
export type AgentWakeCandidate = z.infer<typeof agentWakeCandidateSchema>;
export type AgentWakeSignal = z.infer<typeof agentWakeSignalSchema>;
export type AgentWakeCheckpoint = z.infer<typeof agentWakeCheckpointSchema>;
export type AgentWakeRepairReason = z.infer<typeof agentWakeRepairReasonSchema>;
export type AgentWakeRepairRequired = z.infer<typeof agentWakeRepairRequiredSchema>;
export type AgentWakeStreamRecord = z.infer<typeof agentWakeStreamRecordSchema>;

/**
 * Returns the one canonical string whose UTF-8 SHA-256 digest identifies this logical wake.
 * A JSON tuple makes field order explicit and prevents ambiguous concatenation.
 */
export function encodeAgentWakeKeyInput(input: AgentWakeKeyInput): string {
  const value = agentWakeKeyInputSchema.parse(input);
  return JSON.stringify([
    AGENT_WAKE_KEY_DOMAIN,
    value.workspaceId,
    value.agentUserId,
    value.messageId,
  ]);
}

export function getAgentWakeKeyInput(
  candidate: Pick<AgentWakeCandidate, "workspaceId" | "agentUserId" | "messageId">,
): AgentWakeKeyInput {
  return agentWakeKeyInputSchema.parse({
    version: 1,
    workspaceId: candidate.workspaceId,
    agentUserId: candidate.agentUserId,
    messageId: candidate.messageId,
  });
}

/** Attaches a runtime-computed SHA-256 digest while revalidating the strict final signal. */
export function createAgentWakeSignal(
  candidate: AgentWakeCandidate,
  wakeId: AgentWakeId,
): AgentWakeSignal {
  return agentWakeSignalSchema.parse({ ...candidate, wakeId });
}

/**
 * Classifies a validated product event without consulting local focus, notification state,
 * message text, history, or participated-thread state.
 */
export function classifyAgentWake(
  event: ProductRealtimeEvent,
  conversationKind: ConversationKind,
  agentUserId: EntityId,
): AgentWakeCandidate | null {
  if (event.type !== "message.created") {
    return null;
  }

  const { message, mentionedUserIds } = event.payload;
  if (message.authorId === null || message.authorId === agentUserId) {
    return null;
  }

  const reason: AgentWakeReason | null = mentionedUserIds.includes(agentUserId)
    ? "verified_mention"
    : conversationKind === "direct_message"
      ? "direct_message"
      : null;
  if (reason === null) {
    return null;
  }

  return agentWakeCandidateSchema.parse({
    version: 1,
    type: "agent.wake",
    delivery: "at_least_once",
    eventId: event.id,
    workspaceSequence: event.workspaceSequence,
    workspaceId: event.workspaceId,
    agentUserId,
    conversationId: event.conversationId,
    messageId: message.id,
    threadRootId: message.threadRootId,
    occurredAt: event.occurredAt,
    reason,
  });
}
