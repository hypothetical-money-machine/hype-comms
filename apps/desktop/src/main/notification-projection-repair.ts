import {
  CONVERSATION_PAGE_MAX_LIMIT,
  type ConversationSummary,
  type ListConversationsQuery,
  type ListConversationsResponse,
  type ListMembersResponse,
  type User,
} from "@hype-comms/contracts";

import {
  NOTIFICATION_CONVERSATION_LIMIT,
  type NotificationRepairReason,
} from "./notification-controller";

export interface NotificationProjectionRepairScope {
  readonly sessionGeneration: number;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface NotificationProjectionRepairTransport {
  members(): Promise<ListMembersResponse>;
  conversations(input: Partial<ListConversationsQuery>): Promise<ListConversationsResponse>;
}

export interface NotificationProjectionRepairTarget {
  replaceMembers(members: readonly User[]): boolean;
  replaceConversations(conversations: readonly ConversationSummary[]): boolean;
  disableConversationProjection(): void;
}

export type NotificationProjectionRepairFailure =
  "members" | "conversations" | "conversation_limit";

export type NotificationProjectionRepairResult = "applied" | "failed" | "stale" | "overflow";

type NotificationProjectionRepairAttemptResult = NotificationProjectionRepairResult | "superseded";

interface InFlightProjectionRepair {
  revision: number;
  disabling: boolean;
  committing: boolean;
  readonly promise: Promise<NotificationProjectionRepairResult>;
}

export interface NotificationConversationCatalogSeed {
  readonly conversations: readonly ConversationSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

function scopeKey(scope: NotificationProjectionRepairScope, reason: NotificationRepairReason) {
  return [scope.sessionGeneration, scope.userId, scope.workspaceId, reason].join(":");
}

function scopesMatch(
  left: NotificationProjectionRepairScope,
  right: NotificationProjectionRepairScope,
): boolean {
  return (
    left.sessionGeneration === right.sessionGeneration &&
    left.userId === right.userId &&
    left.workspaceId === right.workspaceId
  );
}

/**
 * Repairs only the notification controller's ephemeral label projection. It deliberately has no
 * renderer sync, acknowledgement, read-cursor, or encrypted-replica port.
 */
export class NotificationProjectionRepairCoordinator {
  readonly #transport: NotificationProjectionRepairTransport;
  readonly #target: NotificationProjectionRepairTarget;
  readonly #getScope: () => NotificationProjectionRepairScope | null;
  readonly #onFailure: (failure: NotificationProjectionRepairFailure) => void;
  readonly #inFlight = new Map<string, InFlightProjectionRepair>();

  constructor(options: {
    readonly transport: NotificationProjectionRepairTransport;
    readonly target: NotificationProjectionRepairTarget;
    readonly getScope: () => NotificationProjectionRepairScope | null;
    readonly onFailure: (failure: NotificationProjectionRepairFailure) => void;
  }) {
    this.#transport = options.transport;
    this.#target = options.target;
    this.#getScope = options.getScope;
    this.#onFailure = options.onFailure;
  }

  request(reason: NotificationRepairReason): Promise<NotificationProjectionRepairResult> {
    const scope = this.#readScope();
    if (scope === null) return Promise.resolve("stale");

    return this.#schedule(reason, scope);
  }

  seedConversationCatalog(
    seed: NotificationConversationCatalogSeed,
  ): Promise<NotificationProjectionRepairResult> {
    const scope = this.#readScope();
    if (scope === null) return Promise.resolve("stale");
    return this.#schedule("conversations", scope, seed);
  }

  #schedule(
    reason: NotificationRepairReason,
    scope: NotificationProjectionRepairScope,
    seed?: NotificationConversationCatalogSeed,
  ): Promise<NotificationProjectionRepairResult> {
    const key = scopeKey(scope, reason);
    const current = this.#inFlight.get(key);
    if (current !== undefined) {
      // `disableConversationProjection()` synchronously asks for the repair it is already being
      // called from. Do not mistake that re-entrant request for a later server invalidation.
      if (!current.disabling && !current.committing) current.revision += 1;
      return current.promise;
    }

    // Defer the repair by one microtask so the in-flight entry exists before a projection target
    // can synchronously request the same repair again after rejecting an authoritative result.
    let conversationDisableFailed = false;
    const entry: InFlightProjectionRepair = {
      revision: 1,
      disabling: reason === "conversations",
      committing: false,
      promise: Promise.resolve()
        .then(() => {
          if (conversationDisableFailed) return this.#failure("conversations");
          return this.#repairUntilCurrent(reason, scope, entry, seed);
        })
        .catch(() => this.#failure(reason)),
    };
    const operation = entry.promise;
    this.#inFlight.set(key, entry);
    if (reason === "conversations") {
      try {
        this.#target.disableConversationProjection();
      } catch {
        conversationDisableFailed = true;
      } finally {
        entry.disabling = false;
      }
    }
    void operation.then(() => {
      if (this.#inFlight.get(key) === entry) this.#inFlight.delete(key);
    });
    return operation;
  }

  async #repairUntilCurrent(
    reason: NotificationRepairReason,
    scope: NotificationProjectionRepairScope,
    entry: InFlightProjectionRepair,
    seed?: NotificationConversationCatalogSeed,
  ): Promise<NotificationProjectionRepairResult> {
    let firstAttempt = true;
    for (;;) {
      if (!this.#isCurrent(scope)) return "stale";
      const revision = entry.revision;
      // A bootstrap page predates any invalidation that arrived after this operation was created.
      // Once superseded, re-read the whole catalog instead of reusing that possibly stale seed.
      const attemptSeed = firstAttempt && revision === 1 ? seed : undefined;
      firstAttempt = false;
      const isLatest = (): boolean => entry.revision === revision;
      let result: NotificationProjectionRepairAttemptResult;
      try {
        result =
          reason === "members"
            ? await this.#repairMembers(scope, entry, isLatest)
            : await this.#repairConversations(scope, entry, attemptSeed, isLatest);
      } catch {
        if (!this.#isCurrent(scope)) return "stale";
        if (!isLatest()) continue;
        return this.#failure(reason);
      }
      if (result === "stale") return result;
      if (result === "superseded" || !isLatest()) continue;
      return result;
    }
  }

  async #repairMembers(
    scope: NotificationProjectionRepairScope,
    entry: InFlightProjectionRepair,
    isLatest: () => boolean,
  ): Promise<NotificationProjectionRepairAttemptResult> {
    const response = await this.#transport.members();
    if (!this.#isCurrent(scope)) return "stale";
    if (!isLatest()) return "superseded";
    entry.committing = true;
    try {
      return this.#target.replaceMembers(response.members) ? "applied" : this.#failure("members");
    } finally {
      entry.committing = false;
    }
  }

  async #repairConversations(
    scope: NotificationProjectionRepairScope,
    entry: InFlightProjectionRepair,
    seed?: NotificationConversationCatalogSeed,
    isLatest: () => boolean = () => true,
  ): Promise<NotificationProjectionRepairAttemptResult> {
    const conversations: ConversationSummary[] = [...(seed?.conversations ?? [])];
    const seenCursors = new Set<string>();
    let after = seed?.hasMore === true ? (seed.nextCursor ?? undefined) : undefined;
    const needsPage = seed === undefined || seed.hasMore;

    if (
      conversations.length > NOTIFICATION_CONVERSATION_LIMIT ||
      (conversations.length === NOTIFICATION_CONVERSATION_LIMIT && seed?.hasMore === true)
    ) {
      return this.#conversationOverflow();
    }
    if (seed !== undefined) {
      if ((seed.hasMore && after === undefined) || (!seed.hasMore && seed.nextCursor !== null)) {
        return this.#failure("conversations");
      }
      if (after !== undefined) seenCursors.add(after);
    }

    while (needsPage) {
      if (!this.#isCurrent(scope)) return "stale";
      if (!isLatest()) return "superseded";
      const response = await this.#transport.conversations({
        ...(after === undefined ? {} : { after }),
        limit: CONVERSATION_PAGE_MAX_LIMIT,
      });
      if (!this.#isCurrent(scope)) return "stale";
      if (!isLatest()) return "superseded";

      if (conversations.length + response.conversations.length > NOTIFICATION_CONVERSATION_LIMIT) {
        return this.#conversationOverflow();
      }
      conversations.push(...response.conversations);

      if (!response.hasMore) {
        if (response.nextCursor !== null) return this.#failure("conversations");
        break;
      }
      const nextCursor = response.nextCursor;
      if (
        response.conversations.length === 0 ||
        nextCursor === null ||
        nextCursor === after ||
        seenCursors.has(nextCursor) ||
        conversations.length >= NOTIFICATION_CONVERSATION_LIMIT
      ) {
        return conversations.length >= NOTIFICATION_CONVERSATION_LIMIT
          ? this.#conversationOverflow()
          : this.#failure("conversations");
      }
      seenCursors.add(nextCursor);
      after = nextCursor;
    }

    if (!this.#isCurrent(scope)) return "stale";
    if (!isLatest()) return "superseded";
    entry.committing = true;
    try {
      return this.#target.replaceConversations(conversations)
        ? "applied"
        : this.#failure("conversations");
    } finally {
      entry.committing = false;
    }
  }

  #readScope(): NotificationProjectionRepairScope | null {
    try {
      const scope = this.#getScope();
      return scope === null ? null : { ...scope };
    } catch {
      return null;
    }
  }

  #isCurrent(scope: NotificationProjectionRepairScope): boolean {
    const current = this.#readScope();
    return current !== null && scopesMatch(current, scope);
  }

  #failure(
    failure: NotificationProjectionRepairFailure,
    result: NotificationProjectionRepairResult = "failed",
  ): NotificationProjectionRepairResult {
    try {
      this.#onFailure(failure);
    } catch {
      // Diagnostics must never turn projection repair into a notification or realtime failure.
    }
    return result;
  }

  #conversationOverflow(): NotificationProjectionRepairResult {
    return this.#failure("conversation_limit", "overflow");
  }
}
