import type { FastifyRequest } from "fastify";

import { ApiError } from "../../errors.js";

export type RealtimePrincipal = {
  readonly userId: string;
  readonly workspaceId: string;
} & (
  | { readonly deviceSessionId: string; readonly agentTokenId: null }
  | { readonly deviceSessionId: null; readonly agentTokenId: string }
);

/**
 * Outcome of re-checking a live connection's bound credential and workspace membership.
 * `valid` means the socket may keep receiving events; every other arm must close it.
 */
export type RealtimePrincipalRevalidation =
  | { readonly status: "valid" }
  | {
      readonly status: "invalid";
      readonly reason:
        | "unknown_session"
        | "session_revoked"
        | "session_expired"
        | "unknown_agent_token"
        | "agent_token_revoked"
        | "agent_disabled"
        | "membership_inactive";
    };

/** Implementations re-check the bound device session/agent token and membership without consuming. */
export type RevalidateRealtimePrincipal = (
  principal: RealtimePrincipal,
) => Promise<RealtimePrincipalRevalidation>;

export interface ConsumeRealtimeTicketInput {
  readonly ticket: string;
  readonly origin: string | undefined;
  readonly request: FastifyRequest;
}

/** Implementations must atomically validate, expire, and consume the one-time ticket. */
export type ConsumeRealtimeTicket = (
  input: ConsumeRealtimeTicketInput,
) => Promise<RealtimePrincipal>;

export const denyRealtimeTickets: ConsumeRealtimeTicket = async () => {
  throw new ApiError(503, "SERVICE_UNAVAILABLE", "Realtime ticket verification is not configured");
};
