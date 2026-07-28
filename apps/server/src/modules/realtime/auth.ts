import type { FastifyRequest } from "fastify";

import { ApiError } from "../../errors.js";

export interface RealtimePrincipal {
  readonly userId: string;
  readonly workspaceId: string;
  /** The device session the ticket was bound to, so a live socket stays revalidatable. */
  readonly deviceSessionId: string;
  /** False/absent for tickets issued to clients predating reaction sync events. */
  readonly reactionEvents?: boolean;
}

/**
 * Outcome of re-checking a live connection's device session and workspace membership.
 * `valid` means the socket may keep receiving events; every other arm must close it.
 */
export type RealtimePrincipalRevalidation =
  | { readonly status: "valid" }
  | {
      readonly status: "invalid";
      readonly reason:
        "unknown_session" | "session_revoked" | "session_expired" | "membership_inactive";
    };

/** Implementations re-check the device session and membership without consuming anything. */
export type RevalidateRealtimePrincipal = (
  principal: RealtimePrincipal,
) => Promise<RealtimePrincipalRevalidation>;

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
