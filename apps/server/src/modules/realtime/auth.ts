import type { Sequence } from "@hmm-chat/contracts";
import type { FastifyRequest } from "fastify";

import { ApiError } from "../../errors.js";

export interface RealtimePrincipal {
  readonly userId: string;
  readonly workspaceId: string;
  readonly workspaceSequence: Sequence;
}

export interface ConsumeRealtimeTicketInput {
  readonly ticket: string;
  readonly origin: string;
  readonly request: FastifyRequest;
}

/** Implementations must atomically validate, expire, and consume the one-time ticket. */
export type ConsumeRealtimeTicket = (
  input: ConsumeRealtimeTicketInput,
) => Promise<RealtimePrincipal>;

export const denyRealtimeTickets: ConsumeRealtimeTicket = async () => {
  throw new ApiError(503, "SERVICE_UNAVAILABLE", "Realtime ticket verification is not configured");
};
