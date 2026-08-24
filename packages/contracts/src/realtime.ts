import { z } from "zod";

import {
  entityIdSchema,
  entityVersionSchema,
  isoDateTimeSchema,
  sequenceSchema,
} from "./common.js";
import { apiErrorEnvelopeSchema } from "./http.js";

export const realtimeDeliverySemanticsSchema = z.literal("at_least_once");
/** Wake-only opt-in for a requested-cursor handshake before authorized realtime replay. */
export const AGENT_WAKE_REALTIME_PREAMBLE = "agent-wake-v1";
export const realtimeTicketSchema = z
  .string()
  .min(32)
  .max(2_048)
  .regex(/^[A-Za-z0-9._~-]+$/);

/**
 * Single source of truth for the realtime connection state that crosses IPC. Main, preload,
 * and the renderer all validate against this schema instead of re-declaring the literals.
 */
export const realtimeConnectionStateSchema = z.enum([
  "connecting",
  "live",
  "offline",
  "reconnecting",
  "incompatible",
]);

/**
 * Main-process generation stamped onto every renderer-bound realtime frame. The epoch is minted
 * before a connection is activated, so the renderer can install the whole scope as an immutable
 * expectation before the first socket callback is possible.
 */
export const realtimeSessionScopeSchema = z
  .object({
    userId: entityIdSchema,
    workspaceId: entityIdSchema,
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .readonly();

export const realtimeAcknowledgementSchema = z
  .object({
    scope: realtimeSessionScopeSchema,
    cursor: sequenceSchema,
  })
  .strict();

/**
 * Best-effort activity travels on the authenticated realtime socket but is deliberately not a
 * realtime event envelope: it has no event id, occurrence time, sequence, entity version, or
 * delivery promise that could make callers mistake it for replayable workspace state.
 */
export const presenceStateSchema = z.enum(["online", "away", "offline"]);

export const clientPresenceActivityFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("activity.presence.set"),
    state: presenceStateSchema.exclude(["offline"]),
  })
  .strict();

export const clientTypingActivityFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("activity.typing.set"),
    conversationId: entityIdSchema,
    typing: z.boolean(),
  })
  .strict();

export const clientEphemeralActivityFrameSchema = z.discriminatedUnion("type", [
  clientPresenceActivityFrameSchema,
  clientTypingActivityFrameSchema,
]);

export const presenceActivityFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("activity.presence"),
    workspaceId: entityIdSchema,
    userId: entityIdSchema,
    state: presenceStateSchema,
  })
  .strict();

export const typingActivityFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("activity.typing"),
    workspaceId: entityIdSchema,
    conversationId: entityIdSchema,
    userId: entityIdSchema,
    typing: z.boolean(),
  })
  .strict();

export const ephemeralActivityFrameSchema = z.discriminatedUnion("type", [
  presenceActivityFrameSchema,
  typingActivityFrameSchema,
]);

/** IPC wrapper fencing best-effort activity to the renderer session that owns its socket. */
export const scopedEphemeralActivityFrameSchema = z
  .object({
    scope: realtimeSessionScopeSchema,
    activity: ephemeralActivityFrameSchema,
  })
  .strict();

/** The only renderer-authored activity command; presence is inferred in the main process. */
export const typingActivityUpdateSchema = clientTypingActivityFrameSchema.pick({
  conversationId: true,
  typing: true,
});

export const scopedTypingActivityUpdateSchema = typingActivityUpdateSchema
  .extend({ scope: realtimeSessionScopeSchema })
  .strict();

export const realtimeEventTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);

export const realtimeEventEnvelopeSchema = z
  .object({
    version: z.literal(1),
    id: entityIdSchema,
    type: realtimeEventTypeSchema,
    occurredAt: isoDateTimeSchema,
    workspaceId: entityIdSchema.nullable(),
    conversationId: entityIdSchema.nullable(),
    workspaceSequence: sequenceSchema,
    conversationSequence: sequenceSchema.nullable(),
    entityVersion: entityVersionSchema,
    delivery: realtimeDeliverySemanticsSchema,
    payload: z.unknown(),
  })
  .strict();

export const systemConnectedEventSchema = realtimeEventEnvelopeSchema.extend({
  type: z.literal("system.connected"),
  workspaceId: entityIdSchema,
  conversationId: z.null(),
  conversationSequence: z.null(),
  payload: z
    .object({
      connectionId: entityIdSchema,
      userId: entityIdSchema,
    })
    .strict(),
});

export const systemErrorEventSchema = realtimeEventEnvelopeSchema.extend({
  type: z.literal("system.error"),
  payload: apiErrorEnvelopeSchema,
});

export type RealtimeConnectionState = z.infer<typeof realtimeConnectionStateSchema>;
export type RealtimeSessionScope = z.infer<typeof realtimeSessionScopeSchema>;
export type RealtimeAcknowledgement = z.infer<typeof realtimeAcknowledgementSchema>;
export type PresenceState = z.infer<typeof presenceStateSchema>;
export type ClientPresenceActivityFrame = z.infer<typeof clientPresenceActivityFrameSchema>;
export type ClientTypingActivityFrame = z.infer<typeof clientTypingActivityFrameSchema>;
export type ClientEphemeralActivityFrame = z.infer<typeof clientEphemeralActivityFrameSchema>;
export type PresenceActivityFrame = z.infer<typeof presenceActivityFrameSchema>;
export type TypingActivityFrame = z.infer<typeof typingActivityFrameSchema>;
export type EphemeralActivityFrame = z.infer<typeof ephemeralActivityFrameSchema>;
export type ScopedEphemeralActivityFrame = z.infer<typeof scopedEphemeralActivityFrameSchema>;
export type TypingActivityUpdate = z.infer<typeof typingActivityUpdateSchema>;
export type ScopedTypingActivityUpdate = z.infer<typeof scopedTypingActivityUpdateSchema>;
export type RealtimeEventEnvelope = z.infer<typeof realtimeEventEnvelopeSchema>;
export type RealtimeDeliverySemantics = z.infer<typeof realtimeDeliverySemanticsSchema>;
export type RealtimeTicket = z.infer<typeof realtimeTicketSchema>;
export type SystemConnectedEvent = z.infer<typeof systemConnectedEventSchema>;
export type SystemErrorEvent = z.infer<typeof systemErrorEventSchema>;
