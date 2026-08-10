import { z } from "zod";

import {
  entityIdSchema,
  entityVersionSchema,
  isoDateTimeSchema,
  sequenceSchema,
} from "./common.js";
import { apiErrorEnvelopeSchema } from "./http.js";

export const realtimeDeliverySemanticsSchema = z.literal("at_least_once");
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
]);

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
export type RealtimeEventEnvelope = z.infer<typeof realtimeEventEnvelopeSchema>;
export type RealtimeDeliverySemantics = z.infer<typeof realtimeDeliverySemanticsSchema>;
export type RealtimeTicket = z.infer<typeof realtimeTicketSchema>;
export type SystemConnectedEvent = z.infer<typeof systemConnectedEventSchema>;
export type SystemErrorEvent = z.infer<typeof systemErrorEventSchema>;
