import type {
  ConversationSummary,
  Message,
  Reaction,
  SyncPosition,
  Task,
} from "@hype-comms/contracts";

import type { RetractReservation } from "./workspace-projection";

export type CacheInvalidation =
  | { readonly kind: "members" }
  | { readonly kind: "conversation_metadata"; readonly conversationId: string }
  | { readonly kind: "membership"; readonly conversationId: string };

/** Records written by one committed transaction, plus removals and required authoritative reads. */
export interface CommittedCacheChanges {
  readonly messages: readonly Message[];
  readonly conversations: readonly ConversationSummary[];
  readonly reactions: readonly Reaction[];
  readonly tasks: readonly Task[];
  readonly removedReactionIds: readonly string[];
  readonly removedMessageReactionIds: readonly string[];
  readonly removedOutboxIds: readonly string[];
  /** Removes all retained records and pending work for a revoked conversation. */
  readonly removedConversationIds: readonly string[];
  readonly retractReservations: readonly RetractReservation[];
  readonly invalidated: readonly CacheInvalidation[];
}

export type CacheEventResult =
  | { readonly status: "ignored"; readonly committedPosition: SyncPosition | null }
  | {
      readonly status: "applied";
      readonly committedPosition: SyncPosition;
      readonly changes: CommittedCacheChanges;
    };

export function committedCacheEvent(
  committedPosition: SyncPosition,
  changes: Partial<CommittedCacheChanges>,
): Extract<CacheEventResult, { status: "applied" }> {
  return {
    status: "applied",
    committedPosition,
    changes: {
      messages: [],
      conversations: [],
      reactions: [],
      tasks: [],
      removedReactionIds: [],
      removedMessageReactionIds: [],
      removedOutboxIds: [],
      removedConversationIds: [],
      retractReservations: [],
      invalidated: [],
      ...changes,
    },
  };
}

export function ignoredCacheEvent(committedPosition: SyncPosition | null): CacheEventResult {
  return { status: "ignored", committedPosition };
}
