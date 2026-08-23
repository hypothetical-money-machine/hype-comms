import { describe, expect, it, vi } from "vitest";

import type {
  AdvanceReadCursorResponse,
  AddReactionResponse,
  AiChannelState,
  Attachment,
  CacheCryptoStatus,
  CacheDecryptBatchResponse,
  CacheEncryptBatchResponse,
  CacheScope,
  ChannelMembershipMutationResponse,
  ChannelMembersResponse,
  ChatSessionState,
  CommunicationPathsResponse,
  ConversationFilesResponse,
  ConversationMutationResponse,
  ConversationSummary,
  CreateChannelOperation,
  CreateTaskOperation,
  DirectConversationRequest,
  ListConversationsQuery,
  ListConversationsResponse,
  ListMembersResponse,
  ListMessageAttachmentsResponse,
  ListMessageReactionsResponse,
  MagicLinkDeliveryState,
  Message,
  MessageByIdResponse,
  MessageHistoryResponse,
  MessageSearchQuery,
  MessageSearchResponse,
  MoveTaskOperation,
  MessageThreadResponse,
  OpenAttachmentResponse,
  NotificationAction as ExactNotificationAction,
  NotificationContext,
  ProductRealtimeEvent,
  Reaction,
  ReactionEmoji,
  RealtimeAcknowledgement,
  RemoveReactionResponse,
  RetractMessageResponse,
  RealtimeConnectionState,
  RealtimeSessionScope,
  SendAttemptResult,
  SendMessageOperation,
  SyncAttemptResult,
  Task,
  TaskListQuery,
  TaskListResponse,
  TaskMutationResponse,
  ThemeState,
  UpdateState,
  User,
  HumanWorkspaceBootstrapResponse,
  UpdateTaskOperation,
  WorkspaceEvent,
  ScopedProductRealtimeEvent,
} from "@hype-comms/contracts";

import type {
  DesktopApi,
  DesktopPlatform,
  NotificationAction,
  ServerStatus,
} from "../../shared/desktop-api";
import type {
  CachedWorkspaceState,
  MembershipRepairMarker,
  OutboxItem,
  RetractReservation,
  WorkspaceCache,
} from "./workspace-cache";
import {
  applyRetractReservation,
  MemoryWorkspaceCache,
  retractReservationMap,
  upsertRetractReservation,
} from "./workspace-cache";
import { WORKSPACE_SNAPSHOT_TASK_LIMIT, WorkspaceRuntime } from "./workspace-runtime";

const USER_ID = "20000000-0000-4000-8000-000000000001";
const PEER_ID = "20000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000003";
const OTHER_USER_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "30000000-0000-4000-8000-000000000003";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000004";
const SECOND_CONVERSATION_ID = "20000000-0000-4000-8000-000000000005";
const OWN_MESSAGE_ID = "20000000-0000-4000-8000-000000000006";
const PEER_MESSAGE_ID = "20000000-0000-4000-8000-000000000007";
const PEER_EVENT_ID = "20000000-0000-4000-8000-000000000008";
const RESYNC_EVENT_ID = "20000000-0000-4000-8000-000000000009";
const OWN_CLIENT_MESSAGE_ID = "20000000-0000-4000-8000-00000000000a";
const PEER_CLIENT_MESSAGE_ID = "20000000-0000-4000-8000-00000000000b";
const CONNECTED_EVENT_ID = "20000000-0000-4000-8000-00000000000c";
const CONNECTION_ID = "20000000-0000-4000-8000-00000000000d";
const CREATED_CHANNEL_ID = "20000000-0000-4000-8000-000000000010";
const DIRECT_CONVERSATION_ID = "20000000-0000-4000-8000-000000000033";
const DIRECT_MESSAGE_ID = "20000000-0000-4000-8000-000000000034";
const DIRECT_CLIENT_MESSAGE_ID = "20000000-0000-4000-8000-000000000035";
const REACTION_ID = "20000000-0000-4000-8000-000000000011";
const REACTION_EVENT_ID = "20000000-0000-4000-8000-000000000012";
const REACTION_REMOVED_EVENT_ID = "20000000-0000-4000-8000-000000000013";
const AGENT_ID = "20000000-0000-4000-8000-000000000014";
const MEMBER_EVENT_ID = "20000000-0000-4000-8000-000000000015";
const SECOND_MEMBER_EVENT_ID = "20000000-0000-4000-8000-000000000016";
const THIRD_MEMBER_EVENT_ID = "20000000-0000-4000-8000-000000000017";
const TASK_ID = "20000000-0000-4000-8000-000000000018";
const THREAD_REPLY_ID = "20000000-0000-4000-8000-000000000020";
const THREAD_REPLY_CLIENT_ID = "20000000-0000-4000-8000-000000000021";
const NOW = "2026-07-24T12:00:00.000Z";
const NEXT_PAGE_CURSOR = "eyJpZCI6InAxIn0";

const scope: CacheScope = { userId: USER_ID, workspaceId: WORKSPACE_ID };

const session: Extract<ChatSessionState, { status: "signed-in"; method: "email" }> = {
  status: "signed-in",
  method: "email",
  name: "Morgan",
  email: "morgan@example.com",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

const otherSession: Extract<ChatSessionState, { status: "signed-in"; method: "email" }> = {
  ...session,
  name: "Alex",
  email: "alex@example.com",
  userId: OTHER_USER_ID,
  workspaceId: OTHER_WORKSPACE_ID,
};

const notificationContext: Extract<NotificationContext, { status: "active" }> = {
  version: 1,
  status: "active",
  sessionGeneration: 7,
  rendererSessionGeneration: 3,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

const notificationAction: ExactNotificationAction = {
  version: 1,
  type: "open-message",
  sessionGeneration: notificationContext.sessionGeneration,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  messageId: PEER_MESSAGE_ID,
  threadRootId: null,
};

const user = {
  id: USER_ID,
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const peer = {
  id: PEER_ID,
  kind: "human",
  username: "cpo",
  displayName: "CPO",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

/**
 * The case the invalidation signal exists for. Disabling this agent drops it from the server's
 * member directory, but the `member.updated` payload has no field that can say so.
 */
const agent: User = {
  id: AGENT_ID,
  kind: "agent",
  username: "hermes",
  displayName: "Hermes",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function memberUpdated(id: string, workspaceSequence: string, member: User): WorkspaceEvent {
  return {
    version: 1,
    id,
    type: "member.updated",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    conversationId: null,
    workspaceSequence,
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { member },
  };
}

function membershipChanged(
  id: string,
  workspaceSequence: string,
  action: "added" | "updated" | "removed" = "updated",
  conversationId = CONVERSATION_ID,
): WorkspaceEvent {
  return {
    version: 1,
    id,
    type: "channel.membership_changed",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    conversationId,
    workspaceSequence,
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { memberId: USER_ID, action },
  };
}

function channel(id: string, slug: string): ConversationSummary {
  return {
    conversation: {
      id,
      workspaceId: WORKSPACE_ID,
      kind: "channel",
      name: slug,
      slug,
      topic: null,
      access: "workspace",
      channelMode: "chat",
      isArchived: false,
      createdBy: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    participantIds: [],
    membershipRole: null,
    lastMessage: null,
    unreadCount: 0,
    mentionCount: 0,
    readCursor: null,
  };
}

function directConversation(id: string, participantIds: readonly string[]): ConversationSummary {
  return {
    conversation: {
      id,
      workspaceId: WORKSPACE_ID,
      kind: "direct_message",
      name: null,
      slug: null,
      topic: null,
      access: null,
      channelMode: null,
      isArchived: false,
      createdBy: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    participantIds: [...participantIds],
    membershipRole: null,
    lastMessage: null,
    unreadCount: 0,
    mentionCount: 0,
    readCursor: null,
  };
}

function catalogConversation(index: number): ConversationSummary {
  return channel(
    `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    `catalog-${String(index)}`,
  );
}

function bootstrapAt(
  syncCursor: string,
  overrides: Partial<HumanWorkspaceBootstrapResponse> = {},
): HumanWorkspaceBootstrapResponse {
  return {
    currentUser: { user, email: "morgan@example.com", workspaceId: WORKSPACE_ID, role: "owner" },
    workspace: {
      id: WORKSPACE_ID,
      name: "Hype Comms",
      slug: "hype-comms",
      createdBy: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    members: [user],
    conversations: [channel(CONVERSATION_ID, "general")],
    conversationsNextCursor: null,
    conversationsHasMore: false,
    syncCursor,
    featureFlags: {
      channels: true,
      directMessages: true,
      mentions: true,
      announcementChannels: false,
    },
    ...overrides,
  };
}

function otherBootstrapAt(syncCursor: string): HumanWorkspaceBootstrapResponse {
  const otherUser = {
    ...user,
    id: OTHER_USER_ID,
    username: "alex",
    displayName: "Alex",
  } as const satisfies User;
  return {
    ...bootstrapAt(syncCursor),
    currentUser: {
      user: otherUser,
      email: "alex@example.com",
      workspaceId: OTHER_WORKSPACE_ID,
      role: "owner",
    },
    workspace: {
      ...bootstrapAt(syncCursor).workspace,
      id: OTHER_WORKSPACE_ID,
      slug: "other-workspace",
      createdBy: OTHER_USER_ID,
    },
    members: [otherUser],
    conversations: [],
  };
}

function message(
  id: string,
  authorId: string,
  conversationSequence: string,
  clientMessageId: string,
): Message {
  return {
    id,
    conversationId: CONVERSATION_ID,
    conversationSequence,
    version: 1,
    clientMessageId,
    authorId,
    threadRootId: null,
    body: authorId === USER_ID ? "Mine" : "Theirs",
    bodyFormat: "hype_comms_markdown_v1",
    editedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const peerMessage = message(PEER_MESSAGE_ID, PEER_ID, "1", PEER_CLIENT_MESSAGE_ID);
const ownMessage = message(OWN_MESSAGE_ID, USER_ID, "2", OWN_CLIENT_MESSAGE_ID);
const threadReply: Message = {
  ...peerMessage,
  id: THREAD_REPLY_ID,
  clientMessageId: THREAD_REPLY_CLIENT_ID,
  conversationSequence: "3",
  threadRootId: OWN_MESSAGE_ID,
  body: "A reply",
};
const ownReaction: Reaction = {
  id: REACTION_ID,
  messageId: OWN_MESSAGE_ID,
  userId: USER_ID,
  emoji: "🎉",
  createdAt: NOW,
};

const task: Task = {
  id: TASK_ID,
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  number: "1",
  version: 1,
  title: "Build the Kanban board",
  description: null,
  status: "todo",
  priority: "high",
  assigneeId: USER_ID,
  dueOn: null,
  sourceMessageId: OWN_MESSAGE_ID,
  rank: "1024",
  createdBy: USER_ID,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function catalogTask(
  index: number,
  conversationId = CONVERSATION_ID,
  workspaceId = WORKSPACE_ID,
): Task {
  const sequence = String(index + 1);
  return {
    ...task,
    id: `50000000-0000-4000-8000-${sequence.padStart(12, "0")}`,
    workspaceId,
    conversationId,
    number: sequence,
    rank: sequence,
    sourceMessageId: null,
    title: `Catalog task ${sequence}`,
  };
}

function taskUpdated(id: string, workspaceSequence: string, updated: Task): WorkspaceEvent {
  return {
    version: 1,
    id,
    type: "task.updated",
    occurredAt: NOW,
    workspaceId: updated.workspaceId,
    conversationId: updated.conversationId,
    workspaceSequence,
    conversationSequence: null,
    entityVersion: updated.version,
    delivery: "at_least_once",
    payload: { task: updated },
  };
}

const reactionAddedEvent: WorkspaceEvent = {
  version: 1,
  id: REACTION_EVENT_ID,
  type: "reaction.added",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  workspaceSequence: "11",
  conversationSequence: "2",
  entityVersion: 1,
  delivery: "at_least_once",
  payload: { reaction: ownReaction },
};

const reactionRemovedEvent: WorkspaceEvent = {
  ...reactionAddedEvent,
  id: REACTION_REMOVED_EVENT_ID,
  type: "reaction.removed",
  workspaceSequence: "12",
};

/** A peer's event whose workspace sequence is below the sequence a send response reports. */
const peerEvent: WorkspaceEvent = {
  version: 1,
  id: PEER_EVENT_ID,
  type: "message.created",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  workspaceSequence: "11",
  conversationSequence: "1",
  entityVersion: 1,
  delivery: "at_least_once",
  payload: { message: peerMessage, mentionedUserIds: [] },
};

/**
 * The server sends this on every socket whose first flush drains, including one it goes on to
 * answer with `system.resync_required` from a later flush, so a healthy handshake proves nothing
 * about the cursor holding up.
 */
function connectedAt(workspaceSequence: string): ProductRealtimeEvent {
  return {
    version: 1,
    id: CONNECTED_EVENT_ID,
    type: "system.connected",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    conversationId: null,
    workspaceSequence,
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { connectionId: CONNECTION_ID, userId: USER_ID },
  };
}

const resyncRequired: ProductRealtimeEvent = {
  version: 1,
  id: RESYNC_EVENT_ID,
  type: "system.resync_required",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: null,
  workspaceSequence: "5",
  conversationSequence: null,
  entityVersion: 1,
  delivery: "at_least_once",
  payload: { reason: "cursor_expired" },
};

type ReplaceSnapshotArgs = Parameters<WorkspaceCache["replaceSnapshot"]>;

/**
 * A hand-written cache that records how often the runtime asks for a full decrypted load, and
 * exposes the sync cursor it has durably accepted.
 */
class FakeWorkspaceCache implements WorkspaceCache {
  readonly mode = "memory_only" as const;
  loadCount = 0;
  reactionUpsertFailures = 0;
  /** Ordered record of the calls whose relative order a test needs to pin, oldest first. */
  readonly operations: string[] = [];
  readonly outboxMutations: {
    readonly type: "enqueue" | "remove";
    readonly clientMessageId: string;
  }[] = [];
  #snapshot: CachedWorkspaceState["bootstrap"] = null;
  #syncCursor: string | null = null;
  readonly #messages = new Map<string, Message>();
  readonly #reactions = new Map<string, Reaction>();
  readonly #tasks = new Map<string, Task>();
  readonly #outbox = new Map<string, OutboxItem>();
  readonly #events = new Set<string>();
  #repairMarker: MembershipRepairMarker | null = null;
  #retractReservations: RetractReservation[] = [];
  readonly memberReplaceBarriers: Promise<void>[] = [];
  readonly acknowledgedMessageBarriers: Promise<void>[] = [];
  readonly loadBarriers: Promise<void>[] = [];
  readonly snapshotReplaceBarriers: Promise<void>[] = [];
  readonly outboxUpdateBarriers: Promise<void>[] = [];
  outboxUpdateAttempts = 0;
  acknowledgedMessageAttempts = 0;
  upsertFailure: Error | null = null;

  get cursor(): string | null {
    return this.#syncCursor;
  }

  async load(): Promise<CachedWorkspaceState> {
    this.loadCount += 1;
    this.operations.push("load");
    const barrier = this.loadBarriers.shift();
    if (barrier !== undefined) await barrier;
    return {
      bootstrap: this.#snapshot,
      messages: [...this.#messages.values()],
      reactions: [...this.#reactions.values()],
      tasks: [...this.#tasks.values()],
      outbox: [...this.#outbox.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      syncCursor: this.#syncCursor,
      lastSyncedAt: null,
      repairMarker: this.#repairMarker,
      retractReservations: this.#retractReservations,
    };
  }

  async replaceSnapshot(...args: ReplaceSnapshotArgs): Promise<boolean> {
    const [snapshot, messages, reactions = [], tasks = [], signal] = args;
    const authorizedConversationIds = new Set(
      snapshot.conversations.map((summary) => summary.conversation.id),
    );
    signal?.throwIfAborted();
    if (
      this.#repairMarker !== null &&
      BigInt(snapshot.syncCursor) < BigInt(this.#repairMarker.workspaceSequence)
    ) {
      throw new Error("Authoritative snapshot predates the membership repair marker");
    }
    this.operations.push("replaceSnapshot");
    const barrier = this.snapshotReplaceBarriers.shift();
    if (barrier !== undefined) await barrier;
    signal?.throwIfAborted();
    if (this.#syncCursor !== null && BigInt(snapshot.syncCursor) < BigInt(this.#syncCursor)) {
      return false;
    }
    const reservations = retractReservationMap(this.#retractReservations);
    this.#snapshot = {
      ...snapshot,
      conversations: snapshot.conversations.map((summary) => {
        if (summary.lastMessage === null) return summary;
        const lastMessage = applyRetractReservation(summary.lastMessage, reservations);
        return lastMessage === summary.lastMessage ? summary : { ...summary, lastMessage };
      }),
    };
    this.#messages.clear();
    for (const item of messages) {
      const retained = applyRetractReservation(item, reservations);
      this.#messages.set(retained.id, retained);
    }
    this.#reactions.clear();
    for (const reaction of reactions) this.#reactions.set(reaction.id, reaction);
    this.#tasks.clear();
    for (const task of tasks) this.#tasks.set(task.id, task);
    for (const [id, item] of this.#outbox) {
      if (!authorizedConversationIds.has(item.operation.conversationId)) this.#outbox.delete(id);
    }
    this.#syncCursor = snapshot.syncCursor;
    this.#repairMarker = null;
    return true;
  }

  async replaceMembers(members: readonly User[], signal?: AbortSignal): Promise<void> {
    this.operations.push("replaceMembers");
    const barrier = this.memberReplaceBarriers.shift();
    if (barrier !== undefined) await barrier;
    signal?.throwIfAborted();
    if (this.#snapshot === null) return;
    this.#snapshot = { ...this.#snapshot, members: [...members] };
  }

  async upsertConversation(summary: ConversationSummary): Promise<void> {
    if (this.upsertFailure !== null) throw this.upsertFailure;
    if (this.#snapshot === null) return;
    this.#snapshot = {
      ...this.#snapshot,
      conversations: [
        summary,
        ...this.#snapshot.conversations.filter(
          (candidate) => candidate.conversation.id !== summary.conversation.id,
        ),
      ],
    };
  }

  async stageMembershipRepair(
    event: Extract<WorkspaceEvent, { type: "channel.membership_changed" }>,
  ): Promise<boolean> {
    if (this.#repairMarker !== null) return false;
    if (this.#syncCursor !== null && BigInt(event.workspaceSequence) <= BigInt(this.#syncCursor)) {
      return false;
    }
    this.#repairMarker = {
      kind: "membership",
      eventId: event.id,
      workspaceSequence: event.workspaceSequence,
      conversationId: event.conversationId,
      selfRemoval: event.payload.action === "removed" && event.payload.memberId === USER_ID,
    };
    this.operations.push("stageMembershipRepair");
    return true;
  }

  async applyEvent(
    event: WorkspaceEvent,
    signal?: AbortSignal,
    retractSource?: Message,
  ): Promise<boolean> {
    void retractSource;
    signal?.throwIfAborted();
    if (this.#repairMarker !== null && event.type !== "channel.membership_changed") {
      throw new Error("Membership repair must complete before applying later events");
    }
    if (this.#events.has(event.id)) return false;
    if (this.#syncCursor !== null && BigInt(event.workspaceSequence) <= BigInt(this.#syncCursor)) {
      return false;
    }
    if (event.type === "channel.membership_changed" && this.#repairMarker === null) {
      await this.stageMembershipRepair(event);
    }
    this.#events.add(event.id);
    this.#syncCursor = event.workspaceSequence;
    this.operations.push(`applyEvent:${event.type}`);
    if (event.type === "channel.membership_changed") {
      const marker = this.#repairMarker;
      if (marker?.selfRemoval) {
        if (this.#snapshot !== null) {
          this.#snapshot = {
            ...this.#snapshot,
            conversations: this.#snapshot.conversations.filter(
              (summary) => summary.conversation.id !== marker.conversationId,
            ),
          };
        }
        const messageIds = new Set(
          [...this.#messages.values()]
            .filter((message) => message.conversationId === marker.conversationId)
            .map((message) => message.id),
        );
        for (const [id, message] of this.#messages) {
          if (message.conversationId === marker.conversationId) this.#messages.delete(id);
        }
        for (const [id, reaction] of this.#reactions) {
          if (messageIds.has(reaction.messageId)) this.#reactions.delete(id);
        }
        for (const [id, task] of this.#tasks) {
          if (task.conversationId === marker.conversationId) this.#tasks.delete(id);
        }
        for (const [id, item] of this.#outbox) {
          if (item.operation.conversationId === marker.conversationId) this.#outbox.delete(id);
        }
      }
    } else if (event.type === "message.created") {
      const created = applyRetractReservation(
        event.payload.message,
        retractReservationMap(this.#retractReservations),
      );
      this.#messages.set(created.id, created);
      this.#outbox.delete(created.clientMessageId);
    } else if (event.type === "message.retracted") {
      this.#retractReservations = upsertRetractReservation(this.#retractReservations, {
        messageId: event.payload.messageId,
        deletedAt: event.payload.deletedAt,
        entityVersion: event.entityVersion,
      });
      for (const [id, reaction] of this.#reactions) {
        if (reaction.messageId === event.payload.messageId) this.#reactions.delete(id);
      }
      const current = this.#messages.get(event.payload.messageId);
      if (current !== undefined) {
        this.#messages.set(event.payload.messageId, {
          ...current,
          deletedAt: event.payload.deletedAt,
          version: event.entityVersion,
          updatedAt: event.payload.deletedAt,
        });
      }
    } else if (event.type === "reaction.added") {
      this.#reactions.set(event.payload.reaction.id, event.payload.reaction);
    } else if (event.type === "reaction.removed") {
      this.#reactions.delete(event.payload.reaction.id);
    } else if (event.type === "task.created" || event.type === "task.updated") {
      const current = this.#tasks.get(event.payload.task.id);
      if (current === undefined || event.payload.task.version >= current.version) {
        this.#tasks.set(event.payload.task.id, event.payload.task);
      }
    }
    signal?.throwIfAborted();
    return true;
  }

  async advanceCursor(syncCursor: string): Promise<void> {
    if (this.#repairMarker !== null) {
      throw new Error("Membership repair must complete before advancing the cursor");
    }
    if (this.#syncCursor === null || BigInt(syncCursor) > BigInt(this.#syncCursor)) {
      this.#syncCursor = syncCursor;
    }
  }

  async upsertHistory(
    conversationId: string,
    messages: readonly Message[],
    reactions?: readonly Reaction[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    if (
      !this.#snapshot?.conversations.some((summary) => summary.conversation.id === conversationId)
    ) {
      return false;
    }
    if (messages.some((message) => message.conversationId !== conversationId)) {
      throw new Error("The workspace history crossed conversation scope");
    }
    const reservations = retractReservationMap(this.#retractReservations);
    for (const item of messages) {
      const retained = applyRetractReservation(item, reservations);
      this.#messages.set(retained.id, retained);
    }
    if (reactions !== undefined) {
      const messageIds = new Set(messages.map((message) => message.id));
      for (const [id, reaction] of this.#reactions) {
        if (messageIds.has(reaction.messageId)) this.#reactions.delete(id);
      }
      for (const reaction of reactions) this.#reactions.set(reaction.id, reaction);
    }
    signal?.throwIfAborted();
    return true;
  }

  async upsertReaction(
    reaction: Reaction,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (
      signal?.aborted ||
      !this.#snapshot?.conversations.some((summary) => summary.conversation.id === conversationId)
    )
      return false;
    if (this.reactionUpsertFailures > 0) {
      this.reactionUpsertFailures -= 1;
      throw new Error("The encrypted reaction cache is unavailable");
    }
    this.#reactions.set(reaction.id, reaction);
    signal?.throwIfAborted();
    return true;
  }

  async removeReaction(reactionId: string): Promise<void> {
    this.#reactions.delete(reactionId);
  }

  async upsertTasks(tasks: readonly Task[], signal?: AbortSignal): Promise<readonly Task[]> {
    if (signal?.aborted) return [];
    const authorizedIds = new Set(
      this.#snapshot?.conversations.map((summary) => summary.conversation.id) ?? [],
    );
    const accepted = tasks.filter((task) => authorizedIds.has(task.conversationId));
    for (const task of accepted) this.#tasks.set(task.id, task);
    signal?.throwIfAborted();
    return accepted;
  }

  async upsertAcknowledgedMessage(
    item: Message,
    expectedClientMessageId: string,
    syncCursor: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.acknowledgedMessageAttempts += 1;
    await this.acknowledgedMessageBarriers.shift();
    if (signal?.aborted) return false;
    const pending = this.#outbox.get(expectedClientMessageId);
    const authorized = this.#snapshot?.conversations.some(
      (summary) => summary.conversation.id === item.conversationId,
    );
    if (
      this.#repairMarker !== null ||
      pending?.operation.conversationId !== item.conversationId ||
      authorized !== true
    ) {
      return false;
    }
    const retained = applyRetractReservation(
      item,
      retractReservationMap(this.#retractReservations),
    );
    this.#messages.set(retained.id, retained);
    this.#outbox.delete(expectedClientMessageId);
    this.#outbox.delete(item.clientMessageId);
    await this.advanceCursor(syncCursor);
    signal?.throwIfAborted();
    return true;
  }

  async enqueue(
    operation: SendMessageOperation,
    createdAt = NOW,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.#repairMarker !== null) {
      throw new Error("Membership repair must complete before queueing a send");
    }
    if (
      !this.#snapshot?.conversations.some(
        (summary) => summary.conversation.id === operation.conversationId,
      )
    ) {
      return false;
    }
    const id = operation.message.clientMessageId;
    if (this.#outbox.has(id)) return true;
    this.outboxMutations.push({ type: "enqueue", clientMessageId: id });
    this.#outbox.set(id, {
      operation,
      createdAt,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      failureReason: null,
    });
    signal?.throwIfAborted();
    return true;
  }

  async replaceOutbox(
    clientMessageId: string,
    operation: SendMessageOperation,
    createdAt: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted || this.#repairMarker !== null) return false;
    const predecessor = this.#outbox.get(clientMessageId);
    if (
      predecessor?.operation.conversationId !== operation.conversationId ||
      !this.#snapshot?.conversations.some(
        (summary) => summary.conversation.id === operation.conversationId,
      )
    ) {
      return false;
    }
    this.outboxMutations.push({
      type: "enqueue",
      clientMessageId: operation.message.clientMessageId,
    });
    this.#outbox.set(operation.message.clientMessageId, {
      operation,
      createdAt,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      failureReason: null,
    });
    this.outboxMutations.push({ type: "remove", clientMessageId });
    this.#outbox.delete(clientMessageId);
    signal?.throwIfAborted();
    return true;
  }

  async updateOutbox(...args: Parameters<WorkspaceCache["updateOutbox"]>): Promise<boolean> {
    const [clientMessageId, update, signal, expected] = args;
    if (signal?.aborted) return false;
    this.outboxUpdateAttempts += 1;
    const barrier = this.outboxUpdateBarriers.shift();
    if (barrier !== undefined) await barrier;
    if (signal?.aborted) return false;
    const current = this.#outbox.get(clientMessageId);
    if (current === undefined) return false;
    const expectedStatusMatches =
      expected === undefined ||
      current.status === expected.status ||
      (current.status === "sending" && expected.status === "pending");
    if (
      !expectedStatusMatches ||
      (expected !== undefined && current.attemptCount !== expected.attemptCount)
    ) {
      return false;
    }
    this.#outbox.set(clientMessageId, { ...current, ...update });
    return true;
  }

  async removeOutbox(clientMessageId: string): Promise<void> {
    this.outboxMutations.push({ type: "remove", clientMessageId });
    this.#outbox.delete(clientMessageId);
  }

  async clearServerStatePreservingOutbox(): Promise<void> {
    this.#snapshot = null;
    this.#messages.clear();
    this.#reactions.clear();
    this.#tasks.clear();
    this.#events.clear();
    this.#syncCursor = null;
    this.#repairMarker = null;
  }

  async clearAll(): Promise<void> {
    await this.clearServerStatePreservingOutbox();
    this.#outbox.clear();
  }
}

class FakeDesktopApi implements DesktopApi {
  readonly platform: DesktopPlatform = "darwin";
  readonly initialThemeState: ThemeState = {
    preference: "system",
    resolvedThemeId: "dark",
    resolvedColorScheme: "dark",
  };
  readonly initialCompactMode = false;
  bootstrap: HumanWorkspaceBootstrapResponse;
  cryptoStatus: CacheCryptoStatus = {
    mode: "memory_only",
    scope,
    reason: "credential_store_unavailable",
  };
  readonly cryptoStatusResults: (CacheCryptoStatus | Promise<CacheCryptoStatus>)[] = [];
  bootstrapRequests = 0;
  stopRequests = 0;
  readonly stopResults: Promise<void>[] = [];
  /** What `GET /v1/members` answers with. The real route lists active memberships only. */
  members: readonly User[] = [user];
  /** Queued directory responses, for tests that need a slow read to be overtaken by a newer one. */
  readonly memberResults: (ListMembersResponse | Promise<ListMembersResponse>)[] = [];
  /** How many upcoming directory reads fail, standing in for a server still coming back up. */
  memberFailures = 0;
  memberRequests = 0;
  /** How many upcoming bootstrap requests fail, standing in for a server still coming back up. */
  bootstrapFailures = 0;
  /** Queued bootstrap responses, for tests that need a resync download to remain in flight. */
  readonly bootstrapResults: (
    HumanWorkspaceBootstrapResponse | Promise<HumanWorkspaceBootstrapResponse>
  )[] = [];
  /** When set, every handshake is answered with a resync demand, as an unusable cursor is. */
  resyncOnStart = false;
  /** When set, every handshake reports itself live first, exactly as the real server does. */
  connectedOnStart = false;
  readonly conversationPages = new Map<string, ListConversationsResponse>();
  readonly histories = new Map<
    string,
    Omit<MessageHistoryResponse, "attachments"> & { readonly attachments?: Attachment[] }
  >();
  readonly attachments: Attachment[] = [];
  readonly attachmentResults: (
    ListMessageAttachmentsResponse | Promise<ListMessageAttachmentsResponse>
  )[] = [];
  readonly attachmentRequests: string[][] = [];
  readonly conversationFileResults: (
    ConversationFilesResponse | Promise<ConversationFilesResponse>
  )[] = [];
  readonly conversationFileRequests: string[] = [];
  readonly uploadedFiles: string[] = [];
  readonly openedFiles: string[] = [];
  chooseAndUploadResult: Attachment | null | Promise<Attachment | null> = null;
  readonly threadResults: Array<
    Omit<MessageThreadResponse, "attachments"> & { readonly attachments?: Attachment[] }
  > = [];
  readonly threadRequests: {
    readonly messageId: string;
    readonly before?: string;
    readonly limit?: number;
  }[] = [];
  readonly reactions: Reaction[] = [];
  readonly reactionResults: (
    ListMessageReactionsResponse | Promise<ListMessageReactionsResponse>
  )[] = [];
  readonly reactionRequests: string[][] = [];
  readonly addReactionResults: AddReactionResponse[] = [];
  readonly removeReactionResults: RemoveReactionResponse[] = [];
  readonly addedReactions: { readonly messageId: string; readonly emoji: ReactionEmoji }[] = [];
  readonly removedReactions: { readonly messageId: string; readonly emoji: ReactionEmoji }[] = [];
  readonly retractResults: RetractMessageResponse[] = [];
  readonly retractedMessageIds: string[] = [];
  readonly syncResults: (SyncAttemptResult | Promise<SyncAttemptResult>)[] = [];
  readonly sendResults: (
    | SendAttemptResult
    | Promise<SendAttemptResult>
    | {
        readonly status: "accepted";
        readonly response: {
          readonly message: Message;
          readonly syncCursor: string;
          readonly attachments?: readonly Attachment[];
        };
      }
  )[] = [];
  readonly channelResults: (
    ConversationMutationResponse | Promise<ConversationMutationResponse>
  )[] = [];
  readonly startedCursors: string[] = [];
  readonly acknowledged: string[] = [];
  readonly sent: SendMessageOperation[] = [];
  readonly createdChannels: CreateChannelOperation[] = [];
  readonly createdDirectConversations: string[] = [];
  readonly directConversationResults: (
    ConversationMutationResponse | Promise<ConversationMutationResponse>
  )[] = [];
  readonly syncedFrom: string[] = [];
  readonly listedAfter: (string | undefined)[] = [];
  readonly historyRequests: string[] = [];
  readonly historyResults = new Map<
    string,
    (MessageHistoryResponse | Promise<MessageHistoryResponse>)[]
  >();
  readonly messageByIdResults: Array<
    | (Omit<MessageByIdResponse, "attachments"> & { readonly attachments?: Attachment[] })
    | Promise<Omit<MessageByIdResponse, "attachments"> & { readonly attachments?: Attachment[] }>
  > = [];
  readonly messageByIdRequests: string[] = [];
  messageByIdFailures = 0;
  readonly searchResults: (MessageSearchResponse | Promise<MessageSearchResponse>)[] = [];
  readonly searchRequests: MessageSearchQuery[] = [];
  readonly channelMemberResults: (ChannelMembersResponse | Promise<ChannelMembersResponse>)[] = [];
  readonly channelMemberRequests: string[] = [];
  readonly conversationTaskResults: (TaskListResponse | Promise<TaskListResponse>)[] = [];
  readonly myTaskResults: (TaskListResponse | Promise<TaskListResponse>)[] = [];
  readonly conversationTaskRequests: string[] = [];
  readonly conversationTaskPageRequests: {
    readonly conversationId: string;
    readonly after?: string;
    readonly limit?: number;
  }[] = [];
  readonly taskMutationResults: TaskMutationResponse[] = [];
  readonly taskMutations: (CreateTaskOperation | UpdateTaskOperation | MoveTaskOperation)[] = [];
  readCursorFailures = 0;
  readonly readCursorRequests: {
    readonly conversationId: string;
    readonly lastReadMessageId: string;
  }[] = [];
  readonly #eventListeners = new Set<(frame: ScopedProductRealtimeEvent) => void>();
  readonly #connectionListeners = new Set<(state: RealtimeConnectionState) => void>();
  readonly #sessionListeners = new Set<(state: ChatSessionState) => void>();
  readonly #notificationListeners = new Set<(action: NotificationAction) => void>();
  #preparedRealtimeScope: RealtimeSessionScope | null = null;
  #preparedRealtimeCursor: string | null = null;
  #activeRealtimeScope: RealtimeSessionScope | null = null;
  #nextRealtimeEpoch = 0;

  constructor(bootstrap: HumanWorkspaceBootstrapResponse) {
    this.bootstrap = bootstrap;
  }

  emitWorkspaceEvent(event: ProductRealtimeEvent): void {
    const scope = this.#activeRealtimeScope ?? this.#preparedRealtimeScope;
    if (scope === null) return;
    for (const listener of this.#eventListeners) listener({ scope, event });
  }

  emitRealtimeState(state: RealtimeConnectionState): void {
    for (const listener of this.#connectionListeners) listener(state);
  }

  emitSessionState(state: ChatSessionState): void {
    for (const listener of this.#sessionListeners) listener(state);
  }

  emitNotificationAction(action: NotificationAction): void {
    for (const listener of this.#notificationListeners) listener(action);
  }

  async getServerStatus(): Promise<ServerStatus> {
    return "reachable";
  }

  async getSessionState(): Promise<ChatSessionState> {
    return session;
  }

  async retrySession(): Promise<ChatSessionState> {
    return session;
  }

  async requestMagicLink(): Promise<MagicLinkDeliveryState> {
    return { status: "email-sent" };
  }

  async signOut(): Promise<ChatSessionState> {
    return { status: "signed-out" };
  }

  onSessionChanged(listener: (state: ChatSessionState) => void): () => void {
    this.#sessionListeners.add(listener);
    return () => this.#sessionListeners.delete(listener);
  }

  async getAppVersion(): Promise<string> {
    return "0.0.0-test";
  }

  // The updater belongs to the app shell, not the workspace runtime. These throw so that a runtime
  // that starts reaching for them fails loudly here instead of silently observing a no-op updater.
  async getUpdateState(): Promise<UpdateState> {
    throw new Error("The runtime test does not report update state");
  }

  async checkForUpdates(): Promise<void> {
    throw new Error("The runtime test does not check for updates");
  }

  async restartToInstallUpdate(): Promise<void> {
    throw new Error("The runtime test does not install updates");
  }

  onUpdateStateChanged(): () => void {
    throw new Error("The runtime test does not observe update state");
  }

  async getThemeState(): Promise<ThemeState> {
    throw new Error("The runtime test does not report theme state");
  }

  async getSystemThemeState(): Promise<ThemeState> {
    throw new Error("The runtime test does not resolve system theme state");
  }

  async setThemePreference(): Promise<ThemeState> {
    throw new Error("The runtime test does not set a theme");
  }

  async setThemeDesign(): Promise<ThemeState> {
    throw new Error("The runtime test does not design a theme");
  }

  onThemeStateChanged(): () => void {
    throw new Error("The runtime test does not observe theme state");
  }

  async getCompactMode(): Promise<boolean> {
    throw new Error("The runtime test does not report compact mode");
  }

  async setCompactMode(): Promise<boolean> {
    throw new Error("The runtime test does not set compact mode");
  }

  onCompactModeChanged(): () => void {
    throw new Error("The runtime test does not observe compact mode");
  }

  async getAiChannelState(): Promise<AiChannelState> {
    throw new Error("The workspace runtime test does not read AI Channel state");
  }

  async startAiChannel(): Promise<AiChannelState> {
    throw new Error("The workspace runtime test does not start AI Channel");
  }

  async chooseAiChannelWorkspace(): Promise<AiChannelState> {
    throw new Error("The workspace runtime test does not choose an AI Channel folder");
  }

  async newAiChannelSession(): Promise<AiChannelState> {
    throw new Error("The workspace runtime test does not create an AI Channel session");
  }

  async sendAiChannelPrompt(): Promise<AiChannelState> {
    throw new Error("The workspace runtime test does not send AI Channel prompts");
  }

  async cancelAiChannelPrompt(): Promise<AiChannelState> {
    throw new Error("The workspace runtime test does not cancel AI Channel prompts");
  }

  async respondAiChannelPermission(): Promise<AiChannelState> {
    throw new Error("The workspace runtime test does not answer AI Channel permissions");
  }

  onAiChannelStateChanged(): () => void {
    throw new Error("The workspace runtime test does not observe AI Channel state");
  }

  onNotificationAction(listener: (action: NotificationAction) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  async initializeCacheCrypto(): Promise<CacheCryptoStatus> {
    const queued = this.cryptoStatusResults.shift();
    const status = queued === undefined ? this.cryptoStatus : await queued;
    this.cryptoStatus = status;
    return status;
  }

  async encryptCacheRecords(): Promise<CacheEncryptBatchResponse> {
    throw new Error("The runtime test cache does not encrypt records");
  }

  async decryptCacheRecords(): Promise<CacheDecryptBatchResponse> {
    throw new Error("The runtime test cache does not decrypt records");
  }

  async resetCacheCrypto(): Promise<void> {
    this.cryptoStatus = { mode: "memory_only", scope, reason: "credential_store_unavailable" };
  }

  async getWorkspaceBootstrap(): Promise<HumanWorkspaceBootstrapResponse> {
    this.bootstrapRequests += 1;
    if (this.bootstrapFailures > 0) {
      this.bootstrapFailures -= 1;
      throw new Error("The workspace is temporarily unavailable");
    }
    const queued = this.bootstrapResults.shift();
    if (queued !== undefined) return await queued;
    return this.bootstrap;
  }

  async listWorkspaceMembers(): Promise<ListMembersResponse> {
    this.memberRequests += 1;
    if (this.memberFailures > 0) {
      this.memberFailures -= 1;
      throw new Error("The member directory is unavailable");
    }
    const queued = this.memberResults.shift();
    if (queued !== undefined) return await queued;
    return { members: [...this.members] };
  }

  async getCommunicationPaths(): Promise<CommunicationPathsResponse> {
    return { generatedAt: "2026-01-01T00:00:00.000Z", members: [...this.members], paths: [] };
  }

  async listConversations(
    input: Partial<ListConversationsQuery> = {},
  ): Promise<ListConversationsResponse> {
    this.listedAfter.push(input.after);
    return (
      this.conversationPages.get(input.after ?? "") ?? {
        conversations: [],
        nextCursor: null,
        hasMore: false,
      }
    );
  }

  async getConversationMessages(input: {
    readonly conversationId: string;
  }): Promise<MessageHistoryResponse> {
    this.historyRequests.push(input.conversationId);
    const queued = this.historyResults.get(input.conversationId)?.shift();
    if (queued !== undefined) return await queued;
    return {
      threadSummaries: [],
      threadsSupported: true,
      attachments: [],
      messages: [],
      nextCursor: null,
      ...this.histories.get(input.conversationId),
    };
  }

  async getMessageThread(input: {
    readonly messageId: string;
    readonly before?: string;
    readonly limit?: number;
  }): Promise<MessageThreadResponse> {
    this.threadRequests.push(input);
    const response = this.threadResults.shift();
    if (response === undefined) throw new Error("The test queued no thread result");
    return { attachments: [], ...response };
  }

  async retractMessage(messageId: string): Promise<RetractMessageResponse> {
    this.retractedMessageIds.push(messageId);
    const result = this.retractResults.shift();
    if (result === undefined) throw new Error("The test queued no retract-message result");
    return result;
  }

  async getMessageById(messageId: string): Promise<MessageByIdResponse> {
    this.messageByIdRequests.push(messageId);
    if (this.messageByIdFailures > 0) {
      this.messageByIdFailures -= 1;
      throw new Error("The exact message is unavailable");
    }
    const response = this.messageByIdResults.shift();
    if (response === undefined) {
      throw new Error("The workspace runtime test queued no exact-message response");
    }
    return { attachments: [], ...(await response) };
  }

  async listMessageReactions(messageIds: readonly string[]): Promise<ListMessageReactionsResponse> {
    this.reactionRequests.push([...messageIds]);
    const queued = this.reactionResults.shift();
    if (queued !== undefined) return queued;
    return {
      reactions: this.reactions.filter((reaction) => messageIds.includes(reaction.messageId)),
    };
  }

  async addMessageReaction(messageId: string, emoji: ReactionEmoji): Promise<AddReactionResponse> {
    this.addedReactions.push({ messageId, emoji });
    const result = this.addReactionResults.shift();
    if (result === undefined) throw new Error("The test queued no add-reaction result");
    return result;
  }

  async removeMessageReaction(
    messageId: string,
    emoji: ReactionEmoji,
  ): Promise<RemoveReactionResponse> {
    this.removedReactions.push({ messageId, emoji });
    const result = this.removeReactionResults.shift();
    if (result === undefined) throw new Error("The test queued no remove-reaction result");
    return result;
  }

  async searchMessages(input: MessageSearchQuery): Promise<MessageSearchResponse> {
    this.searchRequests.push(input);
    const response = this.searchResults.shift();
    if (response === undefined) throw new Error("The test queued no search result");
    return await response;
  }

  async listConversationFiles(conversationId: string): Promise<ConversationFilesResponse> {
    this.conversationFileRequests.push(conversationId);
    return (
      (await this.conversationFileResults.shift()) ?? {
        files: [],
        nextCursor: null,
        hasMore: false,
      }
    );
  }

  async listMessageAttachments(
    messageIds: readonly string[],
  ): Promise<ListMessageAttachmentsResponse> {
    this.attachmentRequests.push([...messageIds]);
    const queued = this.attachmentResults.shift();
    if (queued !== undefined) return queued;
    return {
      attachments: this.attachments.filter(
        (attachment) => attachment.messageId !== null && messageIds.includes(attachment.messageId),
      ),
    };
  }

  async chooseAndUploadConversationFile(conversationId: string): Promise<Attachment | null> {
    this.uploadedFiles.push(conversationId);
    return this.chooseAndUploadResult;
  }

  async openConversationFile(attachmentId: string): Promise<OpenAttachmentResponse> {
    this.openedFiles.push(attachmentId);
    return { opened: true };
  }

  async listConversationTasks(
    conversationId: string,
    input: Partial<TaskListQuery> = {},
  ): Promise<TaskListResponse> {
    this.conversationTaskRequests.push(conversationId);
    this.conversationTaskPageRequests.push({ conversationId, ...input });
    return (
      (await this.conversationTaskResults.shift()) ?? {
        tasks: [],
        nextCursor: null,
        hasMore: false,
      }
    );
  }

  async listMyTasks(): Promise<TaskListResponse> {
    return (await this.myTaskResults.shift()) ?? { tasks: [], nextCursor: null, hasMore: false };
  }

  async createTask(input: CreateTaskOperation): Promise<TaskMutationResponse> {
    this.taskMutations.push(input);
    const response = this.taskMutationResults.shift();
    if (response === undefined) throw new Error("The test queued no task mutation result");
    return response;
  }

  async updateTask(input: UpdateTaskOperation): Promise<TaskMutationResponse> {
    this.taskMutations.push(input);
    const response = this.taskMutationResults.shift();
    if (response === undefined) throw new Error("The test queued no task mutation result");
    return response;
  }

  async moveTask(input: MoveTaskOperation): Promise<TaskMutationResponse> {
    this.taskMutations.push(input);
    const response = this.taskMutationResults.shift();
    if (response === undefined) throw new Error("The test queued no task mutation result");
    return response;
  }

  async sendConversationMessage(input: SendMessageOperation): Promise<SendAttemptResult> {
    this.sent.push(input);
    const queued = this.sendResults.shift();
    if (queued === undefined) throw new Error("The test queued no send result");
    const result = await queued;
    if (result.status !== "accepted") return result;
    // The real server echoes the client message id it was sent.
    return {
      status: "accepted",
      response: {
        ...result.response,
        attachments: [...(result.response.attachments ?? [])],
        message: { ...result.response.message, clientMessageId: input.message.clientMessageId },
      },
    };
  }

  async createChannel(input: CreateChannelOperation): Promise<ConversationMutationResponse> {
    this.createdChannels.push(input);
    const result = this.channelResults.shift();
    if (result === undefined) throw new Error("The test queued no channel result");
    return await result;
  }

  async archiveChannel(): Promise<ConversationMutationResponse> {
    const result = this.channelResults.shift();
    if (result === undefined) throw new Error("The test queued no archive-channel result");
    return await result;
  }

  async getChannelMembers(conversationId: string): Promise<ChannelMembersResponse> {
    this.channelMemberRequests.push(conversationId);
    const response = this.channelMemberResults.shift();
    if (response === undefined) throw new Error("The test queued no channel members result");
    return await response;
  }

  async upsertChannelMember(): Promise<ChannelMembershipMutationResponse> {
    throw new Error("The runtime test does not update channel members");
  }

  async removeChannelMember(): Promise<ChannelMembershipMutationResponse> {
    throw new Error("The runtime test does not remove channel members");
  }

  async createDirectConversation(
    input: DirectConversationRequest,
  ): Promise<ConversationMutationResponse> {
    this.createdDirectConversations.push(input.memberId);
    const result = this.directConversationResults.shift();
    if (result === undefined) throw new Error("The test queued no direct conversation result");
    return await result;
  }

  async advanceReadCursor(
    conversationId: string,
    lastReadMessageId: string,
  ): Promise<AdvanceReadCursorResponse> {
    this.readCursorRequests.push({ conversationId, lastReadMessageId });
    if (this.readCursorFailures > 0) {
      this.readCursorFailures -= 1;
      throw new Error("The read cursor is temporarily unavailable");
    }
    return {
      readCursor: {
        conversationId,
        userId: USER_ID,
        lastReadMessageId,
        lastReadConversationSequence:
          lastReadMessageId === THREAD_REPLY_ID
            ? "3"
            : lastReadMessageId === OWN_MESSAGE_ID
              ? "2"
              : "1",
        lastReadAt: NOW,
        updatedAt: NOW,
      },
      syncCursor: "1",
    };
  }

  async syncWorkspace(after: string): Promise<SyncAttemptResult> {
    this.syncedFrom.push(after);
    return await (this.syncResults.shift() ?? {
      status: "accepted",
      response: {
        events: [],
        nextCursor: after,
        highWaterCursor: after,
        hasMore: false,
      },
    });
  }

  async startWorkspaceRealtime(after: string): Promise<RealtimeSessionScope> {
    const scope = Object.freeze({
      userId: this.cryptoStatus.scope.userId,
      workspaceId: this.cryptoStatus.scope.workspaceId,
      epoch: ++this.#nextRealtimeEpoch,
    });
    this.#preparedRealtimeScope = scope;
    this.#preparedRealtimeCursor = after;
    return scope;
  }

  async activateWorkspaceRealtime(scope: RealtimeSessionScope): Promise<void> {
    if (this.#preparedRealtimeScope?.epoch !== scope.epoch) {
      throw new Error("The fake realtime scope was superseded");
    }
    this.#activeRealtimeScope = scope;
    const preparedCursor = this.#preparedRealtimeCursor ?? "0";
    const acknowledgedCursor = this.acknowledged.at(-1);
    const startedCursor =
      acknowledgedCursor === undefined || BigInt(preparedCursor) > BigInt(acknowledgedCursor)
        ? preparedCursor
        : acknowledgedCursor;
    this.startedCursors.push(startedCursor);
    // The real server reports the connection live once its first flush drains and sends the resync
    // demand from a later flush on that same socket, then closes it, so the client sees both.
    if (this.connectedOnStart)
      this.emitWorkspaceEvent(connectedAt(this.startedCursors.at(-1) ?? "0"));
    if (this.resyncOnStart) this.emitWorkspaceEvent(resyncRequired);
  }

  async stopWorkspaceRealtime(scope?: RealtimeSessionScope): Promise<void> {
    this.stopRequests += 1;
    if (scope === undefined || this.#activeRealtimeScope?.epoch === scope.epoch) {
      this.#activeRealtimeScope = null;
      this.#preparedRealtimeScope = null;
      this.#preparedRealtimeCursor = null;
    }
    await this.stopResults.shift();
  }

  async acknowledgeWorkspaceEvent(input: RealtimeAcknowledgement): Promise<void> {
    this.acknowledged.push(input.cursor);
  }

  async getRealtimeState(): Promise<RealtimeConnectionState> {
    return "offline";
  }

  onRealtimeStateChanged(listener: (state: RealtimeConnectionState) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  onWorkspaceEvent(listener: (frame: ScopedProductRealtimeEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }
}

class DeterministicMessageServer {
  readonly messages = new Map<string, Message>();
  attempts = 0;

  send(input: SendMessageOperation): SendAttemptResult {
    this.attempts += 1;
    if (this.attempts === 1) {
      // The connection disappears before the server commits anything.
      return { status: "retryable", reason: "network", retryAfterMs: 1_000 };
    }

    let canonical = this.messages.get(input.message.clientMessageId);
    if (canonical === undefined) {
      canonical = {
        ...ownMessage,
        id: "20000000-0000-4000-8000-000000000073",
        clientMessageId: input.message.clientMessageId,
        body: input.message.body,
        conversationSequence: "3",
      };
      this.messages.set(input.message.clientMessageId, canonical);
    }
    if (this.attempts === 2) {
      // The commit is durable, but the response disappears. The next request must reuse the same
      // UUID and receive this canonical row rather than creating a second message.
      return { status: "retryable", reason: "network", retryAfterMs: 1_000 };
    }
    return {
      status: "accepted",
      response: { message: canonical, attachments: [], syncCursor: "11" },
    };
  }

  event(): WorkspaceEvent {
    const canonical = [...this.messages.values()][0];
    if (canonical === undefined) throw new Error("Expected the deterministic message commit");
    return {
      version: 1,
      id: "20000000-0000-4000-8000-000000000074",
      type: "message.created",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: canonical.conversationSequence,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { message: canonical, mentionedUserIds: [] },
    };
  }
}

class DeterministicDeliveryApi extends FakeDesktopApi {
  constructor(
    bootstrap: HumanWorkspaceBootstrapResponse,
    private readonly server: DeterministicMessageServer,
  ) {
    super(bootstrap);
  }

  override async sendConversationMessage(input: SendMessageOperation): Promise<SendAttemptResult> {
    this.sent.push(input);
    return this.server.send(input);
  }
}

/** Drains the runtime's promise chains without depending on real or fake timers. */
async function settle(predicate: () => boolean, label: string): Promise<void> {
  for (let tick = 0; tick < 500; tick += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function drain(): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runtimeWith(api: FakeDesktopApi, cache: WorkspaceCache): WorkspaceRuntime {
  return new WorkspaceRuntime(api, { createCache: () => cache });
}

async function cacheWithDurableMembershipMarker(
  messages: readonly Message[] = [],
): Promise<FakeWorkspaceCache> {
  const privateSummary: ConversationSummary = {
    ...channel(SECOND_CONVERSATION_ID, "leadership"),
    conversation: {
      ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
      access: "members",
    },
    participantIds: [USER_ID],
    membershipRole: "owner",
  };
  const cache = new FakeWorkspaceCache();
  await cache.replaceSnapshot(
    bootstrapAt("10", {
      conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
    }),
    messages,
  );
  await cache.applyEvent(
    membershipChanged(MEMBER_EVENT_ID, "11", "removed", SECOND_CONVERSATION_ID),
  );
  return cache;
}

function addConversationCatalogPages(api: FakeDesktopApi, conversationCount: number): void {
  let remaining = conversationCount;
  let conversation = 0;
  let page = 1;
  while (remaining > 0) {
    const pageSize = Math.min(remaining, 100);
    remaining -= pageSize;
    api.conversationPages.set(`page-${String(page)}`, {
      conversations: Array.from({ length: pageSize }, () => catalogConversation(++conversation)),
      nextCursor: remaining === 0 ? null : `page-${String(page + 1)}`,
      hasMore: remaining !== 0,
    });
    page += 1;
  }
}

function addTaskCatalogPages(api: FakeDesktopApi, taskCount: number): void {
  let taskIndex = 0;
  let remaining = taskCount;
  let page = 1;
  while (remaining > 0) {
    const pageSize = Math.min(remaining, 200);
    remaining -= pageSize;
    api.conversationTaskResults.push({
      tasks: Array.from({ length: pageSize }, () => catalogTask(taskIndex++)),
      nextCursor: remaining === 0 ? null : `task-page-${String(page)}`,
      hasMore: remaining !== 0,
    });
    page += 1;
  }
}

function queuedOperation(
  clientMessageId: string,
  body: string,
  conversationId = CONVERSATION_ID,
): SendMessageOperation {
  return {
    conversationId,
    idempotencyKey: clientMessageId,
    message: {
      threadRootId: null,
      body,
      bodyFormat: "hype_comms_markdown_v1",
      clientMessageId,
      mentionedUserIds: [],
      attachmentIds: [],
    },
  };
}

async function enqueuePermanentFailure(
  cache: WorkspaceCache,
  clientMessageId: string,
  body: string,
  createdAt = NOW,
): Promise<void> {
  await cache.replaceSnapshot(bootstrapAt("0"), []);
  await cache.enqueue(queuedOperation(clientMessageId, body), createdAt);
  await cache.clearServerStatePreservingOutbox();
  await cache.updateOutbox(clientMessageId, {
    status: "permanent_failure",
    attemptCount: 1,
    nextAttemptAt: null,
    failureReason: "validation",
  });
}

describe("WorkspaceRuntime", () => {
  it("cold-opens the authorized cached workspace offline and queues composition without I/O", async () => {
    const cache = new FakeWorkspaceCache();
    await cache.replaceSnapshot(bootstrapAt("10"), [ownMessage], [ownReaction], [task]);
    const api = new FakeDesktopApi(bootstrapAt("99"));
    const runtime = runtimeWith(api, cache);

    await runtime.start(session, { offline: true });

    expect(runtime.state).toMatchObject({
      bootstrap: expect.objectContaining({ syncCursor: "10" }),
      messages: [ownMessage],
      reactions: [ownReaction],
      tasks: [task],
      connection: "offline",
      stale: true,
      busy: false,
      error: null,
    });
    expect(api.bootstrapRequests).toBe(0);
    expect(api.syncedFrom).toEqual([]);
    expect(api.startedCursors).toEqual([]);
    expect(api.historyRequests).toEqual([]);
    expect(api.reactionRequests).toEqual([]);
    expect(api.conversationTaskRequests).toEqual([]);

    await runtime.sendMessage(CONVERSATION_ID, "Written during a cold offline restart", []);
    expect(api.sent).toEqual([]);
    expect(runtime.state.outbox).toHaveLength(1);
    expect((await cache.load()).outbox).toHaveLength(1);
  });

  it("converges two clients after disconnects before and after the canonical commit", async () => {
    vi.useFakeTimers();
    try {
      const initial = bootstrapAt("10");
      const senderCache = new FakeWorkspaceCache();
      await senderCache.replaceSnapshot(initial, []);
      const offlineSender = runtimeWith(new FakeDesktopApi(bootstrapAt("99")), senderCache);
      await offlineSender.start(session, { offline: true });
      await offlineSender.sendMessage(CONVERSATION_ID, "One durable offline message", []);
      const clientMessageId = offlineSender.state.outbox[0]?.operation.message.clientMessageId;
      if (clientMessageId === undefined) throw new Error("Expected the offline outbox item");
      await offlineSender.stop();

      const server = new DeterministicMessageServer();
      const senderApi = new DeterministicDeliveryApi(initial, server);
      const restartedSender = runtimeWith(senderApi, senderCache);
      await restartedSender.start(session);
      await settle(
        () => restartedSender.state.outbox[0]?.status === "retry_wait",
        "disconnect before commit",
      );
      expect(server.attempts).toBe(1);
      expect(server.messages.size).toBe(0);

      await vi.advanceTimersByTimeAsync(1_000);
      await settle(
        () => server.attempts === 2 && restartedSender.state.outbox[0]?.status === "retry_wait",
        "disconnect after commit before response",
      );
      expect(server.messages.size).toBe(1);
      expect(restartedSender.state.outbox).toHaveLength(1);

      const canonical = [...server.messages.values()][0];
      if (canonical === undefined) throw new Error("Expected one canonical server message");
      const initialConversation = initial.conversations[0];
      if (initialConversation === undefined) throw new Error("Expected the initial conversation");
      const observerCache = new FakeWorkspaceCache();
      await observerCache.replaceSnapshot(initial, []);
      const observerBootstrap = bootstrapAt("11", {
        conversations: [
          {
            ...initialConversation,
            lastMessage: canonical,
          },
        ],
      });
      const observerApi = new FakeDesktopApi(observerBootstrap);
      observerApi.syncResults.push({
        status: "accepted",
        response: {
          events: [server.event()],
          nextCursor: "11",
          highWaterCursor: "11",
          hasMore: false,
        },
      });
      const observer = runtimeWith(observerApi, observerCache);
      await observer.start(session);

      await vi.advanceTimersByTimeAsync(1_000);
      await settle(() => restartedSender.state.outbox.length === 0, "idempotent retry response");

      expect(server.attempts).toBe(3);
      expect(server.messages.size).toBe(1);
      expect(senderApi.sent.map((input) => input.message.clientMessageId)).toEqual([
        clientMessageId,
        clientMessageId,
        clientMessageId,
      ]);
      expect(
        restartedSender.state.messages.filter(
          (message) => message.clientMessageId === clientMessageId,
        ),
      ).toEqual([canonical]);
      expect(
        observer.state.messages.filter((message) => message.clientMessageId === clientMessageId),
      ).toEqual([canonical]);

      await restartedSender.stop();
      await observer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs a cached restart from its cursor and hydrates history only when selected", async () => {
    const secondSummary = channel(SECOND_CONVERSATION_ID, "random");
    const secondMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000071",
      clientMessageId: "20000000-0000-4000-8000-000000000072",
      conversationId: SECOND_CONVERSATION_ID,
    };
    const snapshot = bootstrapAt("10", {
      conversations: [channel(CONVERSATION_ID, "general"), secondSummary],
    });
    const cache = new FakeWorkspaceCache();
    await cache.replaceSnapshot(snapshot, [peerMessage, secondMessage], [ownReaction], [task]);
    const api = new FakeDesktopApi(snapshot);
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);
    await settle(() => api.historyRequests.length === 1, "selected history hydration");

    expect(api.syncedFrom).toEqual(["10", "10"]);
    expect(api.bootstrapRequests).toBe(1);
    expect(api.historyRequests).toEqual([CONVERSATION_ID]);
    expect(api.conversationTaskRequests).toEqual([]);
    expect(runtime.state.messages).toEqual([peerMessage, secondMessage]);

    runtime.selectConversation(SECOND_CONVERSATION_ID);
    await settle(() => api.historyRequests.length === 2, "second history hydration");
    expect(api.historyRequests).toEqual([CONVERSATION_ID, SECOND_CONVERSATION_ID]);
  });

  it("replaces a legacy channel mode before syncing or restarting realtime", async () => {
    const cached = bootstrapAt("8");
    const announcement = channel(CONVERSATION_ID, "company-news");
    const capable = bootstrapAt("10", {
      conversations: [
        {
          ...announcement,
          conversation: { ...announcement.conversation, channelMode: "announcement" },
        },
      ],
      featureFlags: {
        channels: true,
        directMessages: true,
        mentions: true,
        announcementChannels: true,
      },
    });
    const cache = new FakeWorkspaceCache();
    await cache.replaceSnapshot(cached, []);
    const api = new FakeDesktopApi(capable);
    api.syncResults.push({
      status: "accepted",
      response: {
        events: [],
        nextCursor: "10",
        highWaterCursor: "10",
        hasMore: false,
      },
    });
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(api.stopRequests).toBe(1);
    expect(runtime.state.bootstrap?.conversations[0]?.conversation.channelMode).toBe(
      "announcement",
    );
    expect(api.syncedFrom).toEqual(["8", "10"]);
    expect(api.startedCursors).toEqual(["10"]);
  });

  it("advances read state only when the renderer exposes a visible message", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [peerMessage, ownMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    runtime.selectConversation(CONVERSATION_ID);
    expect(api.readCursorRequests).toEqual([]);

    runtime.markConversationReadThrough(CONVERSATION_ID, PEER_MESSAGE_ID);
    await settle(() => api.readCursorRequests.length === 1, "read cursor request");
    expect(api.readCursorRequests).toEqual([
      { conversationId: CONVERSATION_ID, lastReadMessageId: PEER_MESSAGE_ID },
    ]);
    await settle(
      () =>
        runtime.state.bootstrap?.conversations[0]?.readCursor?.lastReadMessageId ===
        PEER_MESSAGE_ID,
      "read cursor response projection",
    );

    runtime.markConversationReadThrough(CONVERSATION_ID, PEER_MESSAGE_ID);
    runtime.markConversationReadThrough(CONVERSATION_ID, "10000000-0000-4000-8000-000000000099");
    expect(api.readCursorRequests).toHaveLength(1);

    runtime.markConversationReadThrough(CONVERSATION_ID, OWN_MESSAGE_ID);
    await settle(() => api.readCursorRequests.length === 2, "newer read cursor request");
    expect(api.readCursorRequests[1]).toEqual({
      conversationId: CONVERSATION_ID,
      lastReadMessageId: OWN_MESSAGE_ID,
    });
  });

  it("retries a visible read target after a transient cursor failure", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const api = new FakeDesktopApi(bootstrapAt("10"));
      api.histories.set(CONVERSATION_ID, {
        messages: [peerMessage],
        threadSummaries: [],
        threadsSupported: true,
        nextCursor: null,
      });
      api.readCursorFailures = 1;
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);

      runtime.markConversationReadThrough(CONVERSATION_ID, PEER_MESSAGE_ID);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.readCursorRequests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(api.readCursorRequests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.readCursorRequests).toHaveLength(2);
      expect(runtime.state.bootstrap?.conversations[0]?.readCursor?.lastReadMessageId).toBe(
        PEER_MESSAGE_ID,
      );

      await runtime.stop();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("hydrates reactions with initial history and restores them from the cache", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    api.reactions.push(ownReaction);
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(api.reactionRequests).toEqual([[OWN_MESSAGE_ID]]);
    expect(runtime.state.reactions).toEqual([ownReaction]);
    expect((await cache.load()).reactions).toEqual([ownReaction]);
  });

  it("durably queues and sends a reply with its thread root", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.sendResults.push({ status: "permanent", reason: "validation" });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.sendMessage(CONVERSATION_ID, "Thread reply", [], OWN_MESSAGE_ID);
    await settle(
      () => runtime.state.outbox[0]?.status === "permanent_failure",
      "reply send attempt",
    );

    expect(api.sent[0]?.message.threadRootId).toBe(OWN_MESSAGE_ID);
    expect(runtime.state.outbox[0]?.operation.message.threadRootId).toBe(OWN_MESSAGE_ID);
    expect((await cache.load()).outbox[0]?.operation.message.threadRootId).toBe(OWN_MESSAGE_ID);
  });

  it("hydrates a thread without reading it until the renderer reports visibility", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [{ threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: threadReply }],
      threadsSupported: true,
      nextCursor: null,
    });
    api.threadResults.push({ root: ownMessage, replies: [threadReply], nextCursor: null });
    api.reactions.push(ownReaction);
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.openThread(OWN_MESSAGE_ID);

    expect(runtime.state.selectedThreadRootId).toBe(OWN_MESSAGE_ID);
    expect(runtime.state.threadSummaries[0]?.replyCount).toBe(1);
    expect(runtime.state.messages).toEqual([ownMessage, threadReply]);
    expect(runtime.state.reactions).toEqual([ownReaction]);
    expect((await cache.load()).messages).toEqual([ownMessage, threadReply]);
    expect(api.threadRequests).toEqual([{ messageId: OWN_MESSAGE_ID, limit: 50 }]);
    expect(api.readCursorRequests).toEqual([]);

    runtime.markConversationReadThrough(CONVERSATION_ID, THREAD_REPLY_ID);
    await settle(() => api.readCursorRequests.length === 1, "visible thread read cursor");

    expect(api.readCursorRequests.at(-1)).toEqual({
      conversationId: CONVERSATION_ID,
      lastReadMessageId: THREAD_REPLY_ID,
    });
  });

  it("preserves an open thread and its reactions across a membership refresh", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [{ threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: threadReply }],
      threadsSupported: true,
      nextCursor: null,
    });
    api.threadResults.push(
      { root: ownMessage, replies: [threadReply], nextCursor: null },
      { root: ownMessage, replies: [threadReply], nextCursor: null },
    );
    api.reactions.push(ownReaction);
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    await runtime.openThread(OWN_MESSAGE_ID);

    api.bootstrap = bootstrapAt("11");
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000016",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: USER_ID, action: "updated" },
    });

    await settle(
      () =>
        api.threadRequests.length === 2 &&
        runtime.state.bootstrap?.syncCursor === "11" &&
        runtime.state.messages.some((message) => message.id === THREAD_REPLY_ID),
      "open thread refresh",
    );
    expect(runtime.state.selectedThreadRootId).toBe(OWN_MESSAGE_ID);
    expect(runtime.state.messages).toContainEqual(threadReply);
    expect(runtime.state.reactions).toContainEqual(ownReaction);
    expect((await cache.load()).messages).toContainEqual(threadReply);
    expect((await cache.load()).reactions).toContainEqual(ownReaction);
  });

  it("opens and focuses a reply search hit inside its thread", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.threadResults.push({ root: ownMessage, replies: [threadReply], nextCursor: null });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.openSearchResult({ message: threadReply });

    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.selectedThreadRootId).toBe(OWN_MESSAGE_ID);
    expect(runtime.state.focusedMessageId).toBeNull();
    expect(runtime.state.focusedThreadMessageId).toBe(THREAD_REPLY_ID);
    expect(runtime.state.messages).toContainEqual(ownMessage);
    expect(runtime.state.messages).toContainEqual(threadReply);
    expect(api.readCursorRequests).toEqual([]);
  });

  it("keeps legacy replies inline and focuses them without a thread endpoint", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage, threadReply],
      threadSummaries: [],
      threadsSupported: false,
      nextCursor: null,
    });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.openSearchResult({ message: threadReply });

    expect(runtime.state.threadsSupported).toBe(false);
    expect(runtime.state.messages).toEqual([ownMessage, threadReply]);
    expect(runtime.state.selectedThreadRootId).toBeNull();
    expect(runtime.state.focusedMessageId).toBe(THREAD_REPLY_ID);
    expect(api.threadRequests).toEqual([]);
  });

  it("downgrades a live client to inline replies when the server rolls back", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage, threadReply],
      threadSummaries: [],
      threadsSupported: false,
      nextCursor: null,
    });

    await runtime.openThread(OWN_MESSAGE_ID);

    expect(runtime.state.threadsSupported).toBe(false);
    expect(runtime.state.selectedThreadRootId).toBeNull();
    expect(runtime.state.focusedMessageId).toBe(OWN_MESSAGE_ID);
    expect(runtime.state.messages).toEqual([ownMessage, threadReply]);
    expect(runtime.state.threadError).toBeNull();
    expect(api.threadRequests).toEqual([{ messageId: OWN_MESSAGE_ID, limit: 50 }]);
    expect(api.historyRequests).toEqual([CONVERSATION_ID, CONVERSATION_ID]);
    expect(api.readCursorRequests).toEqual([]);
  });

  it("keeps cached replies inline when history negotiation fails during startup", async () => {
    const cache = new FakeWorkspaceCache();
    await cache.replaceSnapshot(bootstrapAt("9"), [ownMessage, threadReply]);
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.bootstrapFailures = 1;
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(runtime.state.error).toBe("The workspace is temporarily unavailable");
    expect(runtime.state.threadsSupported).toBe(false);
    expect(runtime.state.messages).toEqual([ownMessage, threadReply]);
  });

  it("catches up from the encrypted replica before snapshot replacement and realtime", async () => {
    const cache = new FakeWorkspaceCache();
    await cache.replaceSnapshot(bootstrapAt("9"), [ownMessage]);
    const api = new FakeDesktopApi(bootstrapAt("12"));
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage, peerMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    api.syncResults.push({
      status: "accepted",
      response: {
        events: [peerEvent],
        nextCursor: "12",
        highWaterCursor: "12",
        hasMore: false,
      },
    });
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(api.syncedFrom).toEqual(["9", "12"]);
    expect(api.acknowledged).toEqual(["12", "12"]);
    expect(api.startedCursors).toEqual(["12"]);
    expect(api.historyRequests).toEqual([CONVERSATION_ID]);
    expect(cache.operations.indexOf("applyEvent:message.created")).toBeLessThan(
      cache.operations.indexOf("replaceSnapshot", 1),
    );
    expect(runtime.state.messages).toEqual(expect.arrayContaining([ownMessage, peerMessage]));
    expect((await cache.load()).messages).toEqual(
      expect.arrayContaining([ownMessage, peerMessage]),
    );
  });

  it("reconciles a closed-thread retract during the final HTTP catch-up", async () => {
    const closedThreadReply: Message = {
      ...threadReply,
      body: "@morgan Closed thread reply",
    };
    const attachment: Attachment = {
      id: "20000000-0000-4000-8000-0000000000c9",
      messageId: closedThreadReply.id,
      uploadedBy: PEER_ID,
      fileName: "retracted-thread-file.txt",
      contentType: "text/plain",
      sizeBytes: 32,
      status: "ready",
      downloadUrl: null,
      createdAt: NOW,
    };
    const laterMainMessage: Message = {
      ...ownMessage,
      id: "20000000-0000-4000-8000-0000000000c0",
      clientMessageId: "20000000-0000-4000-8000-0000000000c1",
      conversationSequence: "4",
      body: "Later main-timeline message",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        members: [user, peer],
        conversations: [
          {
            ...channel(CONVERSATION_ID, "general"),
            participantIds: [USER_ID, PEER_ID],
            lastMessage: laterMainMessage,
            unreadCount: 1,
            mentionCount: 1,
          },
        ],
      }),
    );
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage, laterMainMessage],
      threadSummaries: [
        { threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: closedThreadReply },
      ],
      threadsSupported: true,
      nextCursor: null,
    });
    const finalCatchUp = deferred<SyncAttemptResult>();
    api.syncResults.push(finalCatchUp.promise);
    const cache = new MemoryWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    const starting = runtime.start(session);
    await settle(
      () => api.syncedFrom.length === 1,
      "final catch-up begins after history hydration",
    );
    api.conversationFileResults.push({ files: [attachment], nextCursor: null, hasMore: false });
    await runtime.loadConversationFiles(CONVERSATION_ID);
    expect(runtime.state.conversationFiles).toEqual([attachment]);

    finalCatchUp.resolve({
      status: "accepted",
      response: {
        events: [
          {
            version: 1,
            id: "20000000-0000-4000-8000-0000000000c2",
            type: "message.retracted",
            occurredAt: NOW,
            workspaceId: WORKSPACE_ID,
            conversationId: CONVERSATION_ID,
            workspaceSequence: "11",
            conversationSequence: closedThreadReply.conversationSequence,
            entityVersion: 2,
            delivery: "at_least_once",
            payload: { messageId: closedThreadReply.id, deletedAt: NOW },
          },
        ],
        nextCursor: "11",
        highWaterCursor: "11",
        hasMore: false,
      },
    });
    await starting;

    expect(api.syncedFrom).toEqual(["10"]);
    expect(runtime.state.threadSummaries).toEqual([]);
    expect(runtime.state.attachments).toEqual([]);
    expect(runtime.state.conversationFiles).toEqual([]);
    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      lastMessage: { id: laterMainMessage.id, deletedAt: null },
      unreadCount: 0,
      mentionCount: 0,
    });
    const cached = await cache.load();
    expect(cached.bootstrap?.conversations[0]).toMatchObject({
      lastMessage: { id: laterMainMessage.id, deletedAt: null },
      unreadCount: 0,
      mentionCount: 0,
    });

    await runtime.start(session);

    expect(runtime.state.threadSummaries).toEqual([]);
    expect(runtime.state.attachments).toEqual([]);
    expect(runtime.state.conversationFiles).toEqual([]);
  });

  it("refreshes source-less retract totals and clears a stale thread summary after final catch-up", async () => {
    const hiddenMessage: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000e0",
      clientMessageId: "20000000-0000-4000-8000-0000000000e1",
      conversationSequence: "3",
      body: "@morgan Hidden message to retract",
    };
    const latestThreadReply: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000e2",
      clientMessageId: "20000000-0000-4000-8000-0000000000e3",
      conversationSequence: "4",
      body: "Visible latest thread reply",
    };
    const laterMainMessage: Message = {
      ...ownMessage,
      id: "20000000-0000-4000-8000-0000000000d0",
      clientMessageId: "20000000-0000-4000-8000-0000000000d1",
      conversationSequence: "5",
      body: "Later main-timeline message",
    };
    const attachment: Attachment = {
      id: "20000000-0000-4000-8000-0000000000d2",
      messageId: hiddenMessage.id,
      uploadedBy: PEER_ID,
      fileName: "hidden-retracted-file.txt",
      contentType: "text/plain",
      sizeBytes: 32,
      status: "ready",
      downloadUrl: null,
      createdAt: NOW,
    };
    const reaction: Reaction = { ...ownReaction, messageId: hiddenMessage.id };
    const beforeRetract = {
      ...channel(CONVERSATION_ID, "general"),
      participantIds: [USER_ID, PEER_ID],
      lastMessage: laterMainMessage,
      unreadCount: 1,
      mentionCount: 1,
    };
    const afterRetract = {
      ...beforeRetract,
      unreadCount: 0,
      mentionCount: 0,
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", { members: [user, peer], conversations: [beforeRetract] }),
    );
    api.histories.set(CONVERSATION_ID, {
      messages: [latestThreadReply, laterMainMessage],
      threadSummaries: [
        { threadRootId: OWN_MESSAGE_ID, replyCount: 3, latestReply: latestThreadReply },
      ],
      threadsSupported: true,
      nextCursor: null,
    });
    const finalCatchUp = deferred<SyncAttemptResult>();
    api.syncResults.push(finalCatchUp.promise);
    const cache = new MemoryWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    const starting = runtime.start(session);
    await settle(() => api.syncedFrom.length === 1, "source-less final catch-up begins");
    expect(runtime.state.threadSummaries).toEqual([
      { threadRootId: OWN_MESSAGE_ID, replyCount: 3, latestReply: latestThreadReply },
    ]);
    const files = deferred<ConversationFilesResponse>();
    api.conversationFileResults.push(files.promise);
    const loadingFiles = runtime.loadConversationFiles(CONVERSATION_ID);
    await settle(
      () => api.conversationFileRequests.length === 1,
      "source-less file request starts",
    );
    api.bootstrap = bootstrapAt("11", {
      members: [user, peer],
      conversations: [afterRetract],
    });
    finalCatchUp.resolve({
      status: "accepted",
      response: {
        events: [
          {
            version: 1,
            id: "20000000-0000-4000-8000-0000000000d3",
            type: "message.retracted",
            occurredAt: NOW,
            workspaceId: WORKSPACE_ID,
            conversationId: CONVERSATION_ID,
            workspaceSequence: "11",
            conversationSequence: hiddenMessage.conversationSequence,
            entityVersion: 2,
            delivery: "at_least_once",
            payload: { messageId: hiddenMessage.id, deletedAt: NOW },
          },
        ],
        nextCursor: "11",
        highWaterCursor: "11",
        hasMore: false,
      },
    });
    await starting;

    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      lastMessage: { id: laterMainMessage.id, deletedAt: null },
      unreadCount: 0,
      mentionCount: 0,
    });
    expect((await cache.load()).bootstrap?.conversations[0]).toMatchObject({
      lastMessage: { id: laterMainMessage.id, deletedAt: null },
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(runtime.state.threadSummaries).toEqual([]);

    files.resolve({ files: [attachment], nextCursor: null, hasMore: false });
    await loadingFiles;
    expect(runtime.state.conversationFiles).toEqual([]);

    api.reactionResults.push({ reactions: [reaction] });
    api.attachmentResults.push({ attachments: [attachment] });
    await runtime.openSearchResult({ message: hiddenMessage });

    expect(runtime.state.messages).toContainEqual(
      expect.objectContaining({ id: hiddenMessage.id, deletedAt: NOW, version: 2 }),
    );
    expect(runtime.state.reactions).toEqual([]);
    expect(runtime.state.attachments).toEqual([]);

    const offline = runtimeWith(api, cache);
    await offline.start(session, { offline: true });
    expect(offline.state.bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(offline.state.messages).toContainEqual(
      expect.objectContaining({ id: hiddenMessage.id, deletedAt: NOW, version: 2 }),
    );
  });

  it("does not recount an old retracted reply on a later cache reload", async () => {
    const retractedReply: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000c3",
      clientMessageId: "20000000-0000-4000-8000-0000000000c4",
      deletedAt: NOW,
      version: 2,
      updatedAt: NOW,
    };
    const liveReply: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000c5",
      clientMessageId: "20000000-0000-4000-8000-0000000000c6",
      conversationSequence: "4",
      body: "Latest live reply",
    };
    const snapshot = bootstrapAt("10", {
      conversations: [
        {
          ...channel(CONVERSATION_ID, "general"),
          lastMessage: liveReply,
        },
      ],
    });
    const cache = new MemoryWorkspaceCache();
    await cache.replaceSnapshot(snapshot, [ownMessage, retractedReply]);
    const api = new FakeDesktopApi(snapshot);
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [{ threadRootId: OWN_MESSAGE_ID, replyCount: 3, latestReply: liveReply }],
      threadsSupported: true,
      nextCursor: null,
    });
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);
    await settle(
      () => runtime.state.threadSummaries[0]?.latestReply.id === liveReply.id,
      "fresh thread summary",
    );
    expect(runtime.state.threadSummaries[0]?.replyCount).toBe(3);

    await runtime.start(session);

    expect(runtime.state.threadSummaries).toEqual([
      { threadRootId: OWN_MESSAGE_ID, replyCount: 3, latestReply: liveReply },
    ]);
  });

  it("does not attach recreated-window realtime until retryable replica catch-up completes", async () => {
    vi.useFakeTimers();
    try {
      const cache = new FakeWorkspaceCache();
      await cache.replaceSnapshot(bootstrapAt("9"), [ownMessage]);
      const api = new FakeDesktopApi(bootstrapAt("10"));
      api.syncResults.push(
        { status: "retryable", reason: "server", retryAfterMs: 1_000 },
        {
          status: "accepted",
          response: {
            events: [],
            nextCursor: "10",
            highWaterCursor: "10",
            hasMore: false,
          },
        },
      );
      const runtime = runtimeWith(api, cache);

      await runtime.start(session);
      expect(api.syncedFrom).toEqual(["9"]);
      expect(api.startedCursors).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      await settle(() => api.startedCursors.length === 1, "recreated-window realtime start");
      expect(api.syncedFrom).toEqual(["9", "9", "10"]);
      expect(api.acknowledged).toEqual(["10", "10"]);
      expect(api.startedCursors).toEqual(["10"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs a durable marker without skipping a windowless replica gap", async () => {
    const privateMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000050",
      clientMessageId: "20000000-0000-4000-8000-000000000051",
      conversationId: SECOND_CONVERSATION_ID,
    };
    const cache = await cacheWithDurableMembershipMarker([privateMessage]);
    const purged = await cache.load();
    expect(purged.repairMarker?.workspaceSequence).toBe("11");
    expect(purged.messages).not.toContainEqual(privateMessage);
    expect(purged.bootstrap?.conversations.map((item) => item.conversation.id)).not.toContain(
      SECOND_CONVERSATION_ID,
    );

    const firstGapMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-00000000005c",
      clientMessageId: "20000000-0000-4000-8000-00000000005d",
      conversationSequence: "2",
      body: "First message observed while the renderer was absent",
    };
    const secondGapMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-00000000005e",
      clientMessageId: "20000000-0000-4000-8000-00000000005f",
      conversationSequence: "3",
      body: "Second message observed while the renderer was absent",
    };
    const firstGapEvent: WorkspaceEvent = {
      ...peerEvent,
      id: "20000000-0000-4000-8000-000000000060",
      workspaceSequence: "12",
      conversationSequence: "2",
      payload: { message: firstGapMessage, mentionedUserIds: [] },
    };
    const secondGapEvent: WorkspaceEvent = {
      ...peerEvent,
      id: "20000000-0000-4000-8000-000000000061",
      workspaceSequence: "14",
      conversationSequence: "3",
      payload: { message: secondGapMessage, mentionedUserIds: [] },
    };
    const api = new FakeDesktopApi(bootstrapAt("14"));
    api.histories.set(CONVERSATION_ID, {
      // The bounded snapshot hydrates only the newest page. The older gap event remains reachable
      // through this authoritative history cursor instead of being mistaken for UI progress.
      messages: [ownMessage, secondGapMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: "before-windowless-gap",
    });
    const preflight = deferred<SyncAttemptResult>();
    api.syncResults.push(preflight.promise);
    const runtime = runtimeWith(api, cache);
    const starting = runtime.start(session);

    await settle(() => api.syncedFrom.length === 1, "durable marker gap preflight");
    const stillBlocked = await cache.load();
    expect(api.syncedFrom).toEqual(["11"]);
    expect(api.bootstrapRequests).toBe(0);
    expect(api.acknowledged).toEqual([]);
    expect(api.startedCursors).toEqual([]);
    expect(stillBlocked.syncCursor).toBe("11");
    expect(stillBlocked.repairMarker?.workspaceSequence).toBe("11");
    expect(cache.operations.filter((operation) => operation === "replaceSnapshot")).toHaveLength(1);

    preflight.resolve({
      status: "accepted",
      response: {
        events: [firstGapEvent, secondGapEvent],
        nextCursor: "14",
        highWaterCursor: "14",
        hasMore: false,
      },
    });
    await starting;

    const repaired = await cache.load();
    expect(repaired.repairMarker).toBeNull();
    expect(repaired.messages).not.toContainEqual(privateMessage);
    expect(repaired.bootstrap?.conversations.map((item) => item.conversation.id)).not.toContain(
      SECOND_CONVERSATION_ID,
    );
    expect(runtime.state.messages).not.toContainEqual(privateMessage);
    expect(runtime.state.messages).toContainEqual(secondGapMessage);
    expect(runtime.state.messages).not.toContainEqual(firstGapMessage);
    expect(repaired.messages).toContainEqual(secondGapMessage);
    expect(repaired.messages).not.toContainEqual(firstGapMessage);
    expect(runtime.hasOlder(CONVERSATION_ID)).toBe(true);
    expect(runtime.state).toMatchObject({ busy: false, stale: false, error: null });
    expect(api.syncedFrom).toEqual(["11", "14"]);
    expect(api.acknowledged).toEqual(["14"]);
    expect(api.startedCursors).toEqual(["14"]);
    expect(cache.cursor).toBe("14");
    expect(api.bootstrapRequests).toBe(1);
    expect(cache.operations.filter((operation) => operation === "replaceSnapshot")).toHaveLength(2);
    expect(
      cache.operations.filter((operation) => operation === "applyEvent:message.created"),
    ).toHaveLength(0);

    api.histories.set(CONVERSATION_ID, {
      messages: [firstGapMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    await runtime.loadOlder(CONVERSATION_ID);
    expect(runtime.state.messages).toEqual(
      expect.arrayContaining([firstGapMessage, secondGapMessage]),
    );
    expect((await cache.load()).messages).toEqual(
      expect.arrayContaining([firstGapMessage, secondGapMessage]),
    );
    expect(runtime.hasOlder(CONVERSATION_ID)).toBe(false);
  });

  it("keeps a durable marker when the drained high-water outruns the snapshot", async () => {
    const cache = await cacheWithDurableMembershipMarker();
    const api = new FakeDesktopApi(bootstrapAt("13"));
    api.syncResults.push({
      status: "accepted",
      response: {
        events: [],
        nextCursor: "14",
        highWaterCursor: "14",
        hasMore: false,
      },
    });

    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const durable = await cache.load();
    expect(api.syncedFrom).toEqual(["11"]);
    expect(api.acknowledged).toEqual([]);
    expect(api.startedCursors).toEqual([]);
    expect(api.bootstrapRequests).toBe(1);
    expect(durable.syncCursor).toBe("11");
    expect(durable.repairMarker?.workspaceSequence).toBe("11");
    expect(runtime.state).toMatchObject({
      busy: false,
      stale: true,
      error: "The workspace catalog has not caught up to the membership change",
    });
  });

  it.each([
    {
      name: "retryable",
      result: { status: "retryable", reason: "server", retryAfterMs: 1_000 } as const,
      error: null,
    },
    {
      name: "permanent",
      result: { status: "permanent", reason: "forbidden" } as const,
      error: "This device is no longer allowed to sync this workspace.",
    },
  ])("keeps a durable marker when its preflight is $name", async ({ result, error }) => {
    const cache = await cacheWithDurableMembershipMarker();
    const api = new FakeDesktopApi(bootstrapAt("14"));
    api.syncResults.push(result);

    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const durable = await cache.load();
    expect(api.syncedFrom).toEqual(["11"]);
    expect(api.bootstrapRequests).toBe(0);
    expect(api.acknowledged).toEqual([]);
    expect(api.startedCursors).toEqual([]);
    expect(durable.syncCursor).toBe("11");
    expect(durable.repairMarker?.workspaceSequence).toBe("11");
    expect(runtime.state).toMatchObject({ busy: false, stale: true, error });
    await runtime.stop();
  });

  it("automatically resumes a retryable durable-marker preflight", async () => {
    vi.useFakeTimers();
    try {
      const cache = await cacheWithDurableMembershipMarker();
      const api = new FakeDesktopApi(bootstrapAt("14"));
      api.syncResults.push(
        { status: "retryable", reason: "server", retryAfterMs: 1_000 },
        {
          status: "accepted",
          response: {
            events: [],
            nextCursor: "14",
            highWaterCursor: "14",
            hasMore: false,
          },
        },
      );
      const runtime = runtimeWith(api, cache);

      await runtime.start(session);
      expect(api.syncedFrom).toEqual(["11"]);
      expect((await cache.load()).repairMarker?.workspaceSequence).toBe("11");
      expect(api.startedCursors).toEqual([]);

      await vi.advanceTimersByTimeAsync(999);
      expect(api.syncedFrom).toEqual(["11"]);
      await vi.advanceTimersByTimeAsync(1);
      await settle(() => api.startedCursors.length === 1, "durable marker retry recovery");

      expect(api.syncedFrom).toEqual(["11", "11", "14"]);
      expect(api.acknowledged).toEqual(["14"]);
      expect(api.startedCursors).toEqual(["14"]);
      expect((await cache.load()).repairMarker).toBeNull();
      expect(runtime.state).toMatchObject({ busy: false, stale: false, error: null });
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an expired marker cursor to one preflight before snapshot recovery", async () => {
    const cache = await cacheWithDurableMembershipMarker();
    const api = new FakeDesktopApi(bootstrapAt("14"));
    api.syncResults.push({ status: "reset_required", reason: "cursor_expired" });

    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const repaired = await cache.load();
    expect(api.syncedFrom).toEqual(["11", "14"]);
    expect(api.bootstrapRequests).toBe(1);
    expect(api.acknowledged).toEqual(["14"]);
    expect(api.startedCursors).toEqual(["14"]);
    expect(repaired.syncCursor).toBe("14");
    expect(repaired.repairMarker).toBeNull();
    expect(runtime.state).toMatchObject({ busy: false, stale: false, error: null });
  });

  it("preserves an older root referenced by a queued reply across snapshot replacement", async () => {
    const cache = new FakeWorkspaceCache();
    await cache.replaceSnapshot(bootstrapAt("9"), [ownMessage]);
    const queuedReply = {
      ...queuedOperation(THREAD_REPLY_CLIENT_ID, "Queued reply"),
      message: {
        ...queuedOperation(THREAD_REPLY_CLIENT_ID, "Queued reply").message,
        threadRootId: OWN_MESSAGE_ID,
      },
    };
    await cache.enqueue(queuedReply);
    await cache.updateOutbox(THREAD_REPLY_CLIENT_ID, {
      status: "permanent_failure",
      attemptCount: 1,
      nextAttemptAt: null,
      failureReason: "validation",
    });
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [peerMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    api.syncResults.push({
      status: "accepted",
      response: {
        events: [],
        nextCursor: "10",
        highWaterCursor: "10",
        hasMore: false,
      },
    });
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);
    await settle(() => runtime.state.threadsSupported, "selected conversation hydration");

    expect(runtime.state.threadsSupported).toBe(true);
    expect(runtime.state.messages).toContainEqual(ownMessage);
    expect(runtime.state.outbox[0]?.operation.message.threadRootId).toBe(OWN_MESSAGE_ID);
    expect((await cache.load()).messages).toContainEqual(ownMessage);
  });

  it("projects a message.retracted tombstone and drops that message's attachments", async () => {
    const attachment: Attachment = {
      id: "20000000-0000-4000-8000-0000000000ad",
      messageId: OWN_MESSAGE_ID,
      uploadedBy: USER_ID,
      fileName: "secrets.txt",
      contentType: "text/plain",
      sizeBytes: 32,
      status: "ready",
      downloadUrl: null,
      createdAt: NOW,
    };
    const leaked = { ...ownMessage, body: "bot token leaked in comms" };
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [leaked],
      threadSummaries: [],
      threadsSupported: true,
      attachments: [attachment],
      nextCursor: null,
    });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);
    expect(runtime.state.messages).toContainEqual(leaked);
    expect(runtime.state.attachments).toEqual([attachment]);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000ae",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: leaked.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: OWN_MESSAGE_ID, deletedAt: NOW },
    });
    await settle(() => api.acknowledged.includes("11"), "message-retracted acknowledgement");

    expect(runtime.state.messages).toContainEqual(
      expect.objectContaining({
        id: OWN_MESSAGE_ID,
        body: "bot token leaked in comms",
        deletedAt: NOW,
        version: 2,
      }),
    );
    expect(runtime.state.attachments).toEqual([]);
  });

  it("does not restore attachment hydration after a message is retracted", async () => {
    const attachment: Attachment = {
      id: "20000000-0000-4000-8000-0000000000ba",
      messageId: PEER_MESSAGE_ID,
      uploadedBy: PEER_ID,
      fileName: "retracted-file.txt",
      contentType: "text/plain",
      sizeBytes: 64,
      status: "ready",
      downloadUrl: null,
      createdAt: NOW,
    };
    const attachmentHydration = deferred<ListMessageAttachmentsResponse>();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.attachmentResults.push(attachmentHydration.promise);
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    api.emitWorkspaceEvent(peerEvent);
    await settle(() => api.attachmentRequests.length === 1, "attachment hydration starts");
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000bb",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "12",
      conversationSequence: peerMessage.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: PEER_MESSAGE_ID, deletedAt: NOW },
    });
    await settle(() => api.acknowledged.includes("12"), "attachment target retract");

    attachmentHydration.resolve({ attachments: [attachment] });
    await drain();

    expect(runtime.state.attachments).toEqual([]);
    expect(runtime.state.conversationFiles).toEqual([]);
  });

  it("matches a fresh bootstrap after a live retract", async () => {
    const earlierReply: Message = {
      ...threadReply,
      id: PEER_MESSAGE_ID,
      clientMessageId: PEER_CLIENT_MESSAGE_ID,
      conversationSequence: "3",
      body: "Earlier thread reply",
    };
    const latestReply: Message = {
      ...threadReply,
      conversationSequence: "4",
      body: "@morgan Latest thread reply",
    };
    const beforeRetract = {
      ...channel(CONVERSATION_ID, "general"),
      participantIds: [USER_ID, PEER_ID],
      lastMessage: latestReply,
      unreadCount: 1,
      mentionCount: 1,
    };
    const liveApi = new FakeDesktopApi(
      bootstrapAt("10", { members: [user, peer], conversations: [beforeRetract] }),
    );
    liveApi.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [{ threadRootId: OWN_MESSAGE_ID, replyCount: 2, latestReply }],
      threadsSupported: true,
      nextCursor: null,
    });
    liveApi.threadResults.push({
      root: ownMessage,
      replies: [earlierReply, latestReply],
      nextCursor: null,
    });
    const live = runtimeWith(liveApi, new FakeWorkspaceCache());
    await live.start(session);
    await live.openThread(OWN_MESSAGE_ID);

    const reaction: Reaction = { ...ownReaction, messageId: latestReply.id };
    liveApi.emitWorkspaceEvent({
      ...reactionAddedEvent,
      workspaceSequence: "11",
      conversationSequence: latestReply.conversationSequence,
      payload: { reaction },
    });
    await settle(() => live.state.reactions.length === 1, "retract reaction setup");
    liveApi.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000b0",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "12",
      conversationSequence: latestReply.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: latestReply.id, deletedAt: NOW },
    });
    await settle(() => liveApi.acknowledged.includes("12"), "live retract projection");

    const afterRetract = {
      ...beforeRetract,
      lastMessage: earlierReply,
      unreadCount: 0,
      mentionCount: 0,
    };
    const freshApi = new FakeDesktopApi(
      bootstrapAt("12", { members: [user, peer], conversations: [afterRetract] }),
    );
    freshApi.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [{ threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: earlierReply }],
      threadsSupported: true,
      nextCursor: null,
    });
    freshApi.threadResults.push({ root: ownMessage, replies: [earlierReply], nextCursor: null });
    const fresh = runtimeWith(freshApi, new FakeWorkspaceCache());
    await fresh.start(session);
    await fresh.openThread(OWN_MESSAGE_ID);

    const projection = (runtime: WorkspaceRuntime) => ({
      conversations: runtime.state.bootstrap?.conversations,
      messages: runtime.state.messages.filter((message) => message.deletedAt === null),
      threadSummaries: runtime.state.threadSummaries,
      reactions: runtime.state.reactions,
      attachments: runtime.state.attachments,
      conversationFiles: runtime.state.conversationFiles,
    });
    expect(projection(live)).toEqual(projection(fresh));
  });

  it("does not reconcile a locally retracted reply twice when its realtime echo arrives", async () => {
    const ownThreadReply: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000b5",
      clientMessageId: "20000000-0000-4000-8000-0000000000b6",
      authorId: USER_ID,
      conversationSequence: "4",
      body: "My thread reply",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [
          {
            ...channel(CONVERSATION_ID, "general"),
            lastMessage: ownThreadReply,
          },
        ],
      }),
    );
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [
        { threadRootId: OWN_MESSAGE_ID, replyCount: 2, latestReply: ownThreadReply },
      ],
      threadsSupported: true,
      nextCursor: null,
    });
    api.threadResults.push({
      root: ownMessage,
      replies: [threadReply, ownThreadReply],
      nextCursor: null,
    });
    const retracted = { ...ownThreadReply, deletedAt: NOW, version: 2, updatedAt: NOW };
    api.retractResults.push({ message: retracted, syncCursor: "11" });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);
    await runtime.openThread(OWN_MESSAGE_ID);

    await runtime.retractMessage(ownThreadReply.id);
    expect(runtime.state.threadSummaries).toEqual([
      { threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: threadReply },
    ]);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000b7",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: ownThreadReply.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: ownThreadReply.id, deletedAt: NOW },
    });
    await settle(() => api.acknowledged.includes("11"), "local retract realtime echo");

    expect(runtime.state.threadSummaries).toEqual([
      { threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: threadReply },
    ]);
    expect(runtime.state.bootstrap?.conversations[0]?.lastMessage).toEqual(threadReply);
  });

  it("reconciles a history tombstone when its retract event arrives later", async () => {
    const liveReply: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000c1",
      clientMessageId: "20000000-0000-4000-8000-0000000000c2",
      conversationSequence: "4",
      body: "@morgan Reply removed before its event arrived",
    };
    const deletedReply: Message = {
      ...liveReply,
      deletedAt: NOW,
      version: 2,
      updatedAt: NOW,
    };
    const beforeRetract = {
      ...channel(CONVERSATION_ID, "general"),
      participantIds: [USER_ID, PEER_ID],
      lastMessage: liveReply,
      unreadCount: 1,
      mentionCount: 1,
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", { members: [user, peer], conversations: [beforeRetract] }),
    );
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage, liveReply],
      threadSummaries: [{ threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: liveReply }],
      threadsSupported: true,
      nextCursor: null,
    });
    api.threadResults.push({ root: ownMessage, replies: [deletedReply], nextCursor: null });
    const cache = new MemoryWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    await settle(
      () => runtime.state.threadSummaries[0]?.latestReply.id === liveReply.id,
      "live thread summary",
    );

    await runtime.openThread(OWN_MESSAGE_ID);
    expect(runtime.state.messages).toContainEqual(deletedReply);
    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 1,
      mentionCount: 1,
    });

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000c3",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: liveReply.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: liveReply.id, deletedAt: NOW },
    });
    await settle(() => api.acknowledged.includes("11"), "history tombstone retract event");

    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
      lastMessage: { id: OWN_MESSAGE_ID },
    });
    expect(runtime.state.threadSummaries).toEqual([]);
    expect((await cache.load()).bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
      lastMessage: { id: OWN_MESSAGE_ID },
    });
  });

  it("removes a deleted thread root's summary while retaining its live replies", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [
          {
            ...channel(CONVERSATION_ID, "general"),
            lastMessage: threadReply,
            unreadCount: 1,
          },
        ],
      }),
    );
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [{ threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: threadReply }],
      threadsSupported: true,
      nextCursor: null,
    });
    api.threadResults.push({ root: ownMessage, replies: [threadReply], nextCursor: null });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);
    await runtime.openThread(OWN_MESSAGE_ID);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000b1",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: ownMessage.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: OWN_MESSAGE_ID, deletedAt: NOW },
    });
    await settle(() => api.acknowledged.includes("11"), "thread-root retract projection");

    expect(runtime.state.threadSummaries).toEqual([]);
    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      lastMessage: { id: THREAD_REPLY_ID },
      unreadCount: 1,
    });
    expect(runtime.state.selectedThreadRootId).toBeNull();
    expect(runtime.state.focusedThreadMessageId).toBeNull();
  });

  it("removes a closed thread's stale latest reply after a retract", async () => {
    const laterMainMessage: Message = {
      ...ownMessage,
      id: "20000000-0000-4000-8000-0000000000b2",
      clientMessageId: "20000000-0000-4000-8000-0000000000b3",
      conversationSequence: "4",
      body: "Later main message",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [
          {
            ...channel(CONVERSATION_ID, "general"),
            lastMessage: laterMainMessage,
            unreadCount: 1,
          },
        ],
      }),
    );
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage, laterMainMessage],
      threadSummaries: [{ threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: threadReply }],
      threadsSupported: true,
      nextCursor: null,
    });
    const cache = new MemoryWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    await settle(
      () =>
        runtime.state.threadSummaries.some((summary) => summary.latestReply.id === THREAD_REPLY_ID),
      "closed thread summary",
    );
    expect(runtime.state.messages).not.toContainEqual(threadReply);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000b4",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: threadReply.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: THREAD_REPLY_ID, deletedAt: NOW },
    });
    await settle(() => api.acknowledged.includes("11"), "closed thread retract projection");

    expect(runtime.state.threadSummaries).toEqual([]);
    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      lastMessage: { id: laterMainMessage.id },
      unreadCount: 0,
    });
    expect(runtime.state.messages).toContainEqual(
      expect.objectContaining({ id: THREAD_REPLY_ID, deletedAt: NOW, version: 2 }),
    );
    const cached = await cache.load();
    expect(cached.bootstrap?.conversations[0]).toMatchObject({
      lastMessage: { id: laterMainMessage.id },
      unreadCount: 0,
    });
  });

  it("does not restore a locally retracted reply when its create event arrives late", async () => {
    const ownThreadReply: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000bc",
      clientMessageId: "20000000-0000-4000-8000-0000000000bd",
      authorId: USER_ID,
      conversationSequence: "3",
      body: "Reply to retract",
    };
    const retracted = { ...ownThreadReply, deletedAt: NOW, version: 2, updatedAt: NOW };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [
          {
            ...channel(CONVERSATION_ID, "general"),
            lastMessage: ownThreadReply,
          },
        ],
      }),
    );
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [
        { threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: ownThreadReply },
      ],
      threadsSupported: true,
      nextCursor: null,
    });
    api.retractResults.push({ message: retracted, syncCursor: "11" });
    const cache = new MemoryWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    runtime.selectConversation(CONVERSATION_ID);

    await runtime.retractMessage(ownThreadReply.id);
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000be",
      type: "message.created",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: ownThreadReply.conversationSequence,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { message: ownThreadReply, mentionedUserIds: [] },
    });
    await settle(() => api.acknowledged.includes("11"), "late message-created acknowledgement");
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000bf",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "12",
      conversationSequence: ownThreadReply.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: ownThreadReply.id, deletedAt: NOW },
    });
    await settle(() => api.acknowledged.includes("12"), "late retract acknowledgement");

    expect(runtime.state.threadSummaries).toEqual([]);
    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      lastMessage: { id: OWN_MESSAGE_ID, deletedAt: null },
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(runtime.state.messages).toContainEqual(
      expect.objectContaining({ id: ownThreadReply.id, deletedAt: NOW, version: 2 }),
    );
    const cached = await cache.load();
    expect(cached.bootstrap?.conversations[0]).toMatchObject({
      lastMessage: { id: OWN_MESSAGE_ID, deletedAt: null },
      unreadCount: 0,
      mentionCount: 0,
    });
  });

  it("applies DELETE /v1/messages/:id without emptying the stored body", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [
          {
            ...channel(CONVERSATION_ID, "general"),
            lastMessage: ownMessage,
            unreadCount: 4,
            mentionCount: 3,
          },
        ],
      }),
    );
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    api.retractResults.push({
      message: { ...ownMessage, deletedAt: NOW, version: 2, updatedAt: NOW },
      syncCursor: "11",
    });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);
    runtime.selectConversation(CONVERSATION_ID);

    await runtime.retractMessage(OWN_MESSAGE_ID);

    expect(api.retractedMessageIds).toEqual([OWN_MESSAGE_ID]);
    expect(runtime.state.messages).toContainEqual(
      expect.objectContaining({
        id: OWN_MESSAGE_ID,
        body: ownMessage.body,
        deletedAt: NOW,
        version: 2,
      }),
    );
    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 4,
      mentionCount: 3,
    });
  });

  it("does not let stale history resurrect a source-less message.retracted event", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const attachment: Attachment = {
      id: "20000000-0000-4000-8000-0000000000b9",
      messageId: OWN_MESSAGE_ID,
      uploadedBy: USER_ID,
      fileName: "retracted-file.txt",
      contentType: "text/plain",
      sizeBytes: 64,
      status: "ready",
      downloadUrl: null,
      createdAt: NOW,
    };
    api.histories.set(CONVERSATION_ID, {
      messages: [],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    expect(runtime.state.messages).toEqual([]);

    api.conversationFileResults.push({ files: [attachment], nextCursor: null, hasMore: false });
    await runtime.loadConversationFiles(CONVERSATION_ID);
    api.emitWorkspaceEvent(reactionAddedEvent);
    await settle(() => runtime.state.reactions.length === 1, "source-less retract reaction");
    expect(runtime.state.conversationFiles).toEqual([attachment]);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000af",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "12",
      conversationSequence: ownMessage.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: OWN_MESSAGE_ID, deletedAt: NOW },
    });
    await settle(
      () => api.acknowledged.includes("12"),
      "source-less message-retracted acknowledgement",
    );

    expect(runtime.state.messages).toEqual([]);
    expect(runtime.state.reactions).toEqual([]);
    expect(runtime.state.attachments).toEqual([]);
    expect(runtime.state.conversationFiles).toEqual([]);
    expect((await cache.load()).retractReservations).toEqual([
      {
        messageId: OWN_MESSAGE_ID,
        deletedAt: NOW,
        entityVersion: 2,
      },
    ]);

    await runtime.openSearchResult({ message: ownMessage });

    expect(runtime.state.messages).toContainEqual(
      expect.objectContaining({
        id: OWN_MESSAGE_ID,
        body: ownMessage.body,
        deletedAt: NOW,
        version: 2,
      }),
    );
    expect((await cache.load()).messages).toContainEqual(
      expect.objectContaining({
        id: OWN_MESSAGE_ID,
        body: ownMessage.body,
        deletedAt: NOW,
        version: 2,
      }),
    );
  });

  it("refreshes source-less realtime retract totals and clears a stale thread summary", async () => {
    const hiddenMessage: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000e4",
      clientMessageId: "20000000-0000-4000-8000-0000000000e5",
      conversationSequence: "3",
      body: "@morgan Hidden realtime message",
    };
    const latestThreadReply: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000e6",
      clientMessageId: "20000000-0000-4000-8000-0000000000e7",
      conversationSequence: "4",
      body: "Visible realtime thread reply",
    };
    const laterMainMessage: Message = {
      ...ownMessage,
      id: "20000000-0000-4000-8000-0000000000d4",
      clientMessageId: "20000000-0000-4000-8000-0000000000d5",
      conversationSequence: "5",
    };
    const beforeRetract = {
      ...channel(CONVERSATION_ID, "general"),
      participantIds: [USER_ID, PEER_ID],
      lastMessage: laterMainMessage,
      unreadCount: 1,
      mentionCount: 1,
    };
    const afterRetract = { ...beforeRetract, unreadCount: 0, mentionCount: 0 };
    const api = new FakeDesktopApi(
      bootstrapAt("10", { members: [user, peer], conversations: [beforeRetract] }),
    );
    api.histories.set(CONVERSATION_ID, {
      messages: [latestThreadReply, laterMainMessage],
      threadSummaries: [
        { threadRootId: OWN_MESSAGE_ID, replyCount: 3, latestReply: latestThreadReply },
      ],
      threadsSupported: true,
      nextCursor: null,
    });
    const cache = new MemoryWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    expect(runtime.state.threadSummaries).toEqual([
      { threadRootId: OWN_MESSAGE_ID, replyCount: 3, latestReply: latestThreadReply },
    ]);

    api.bootstrap = bootstrapAt("11", {
      members: [user, peer],
      conversations: [afterRetract],
    });
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000d6",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: hiddenMessage.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: hiddenMessage.id, deletedAt: NOW },
    });
    await settle(
      () =>
        runtime.state.bootstrap?.conversations[0]?.unreadCount === 0 &&
        runtime.state.threadSummaries.length === 0,
      "source-less realtime metadata refresh",
    );

    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
    });
    expect((await cache.load()).bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(runtime.state.threadSummaries).toEqual([]);
  });

  it("retries a failed source-less retract metadata refresh without another event", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const hiddenMessage: Message = {
        ...threadReply,
        id: "20000000-0000-4000-8000-0000000000e8",
        clientMessageId: "20000000-0000-4000-8000-0000000000e9",
        conversationSequence: "3",
        body: "@morgan Message outside the cached history page",
      };
      const laterMainMessage: Message = {
        ...ownMessage,
        id: "20000000-0000-4000-8000-0000000000da",
        clientMessageId: "20000000-0000-4000-8000-0000000000db",
        conversationSequence: "5",
        body: "Later main-timeline message",
      };
      const beforeRetract = {
        ...channel(CONVERSATION_ID, "general"),
        participantIds: [USER_ID, PEER_ID],
        lastMessage: laterMainMessage,
        unreadCount: 1,
        mentionCount: 1,
      };
      const afterRetract = { ...beforeRetract, unreadCount: 0, mentionCount: 0 };
      const api = new FakeDesktopApi(
        bootstrapAt("10", { members: [user, peer], conversations: [beforeRetract] }),
      );
      const runtime = runtimeWith(api, new MemoryWorkspaceCache());
      await runtime.start(session);

      api.bootstrap = bootstrapAt("11", {
        members: [user, peer],
        conversations: [afterRetract],
      });
      api.bootstrapFailures = 1;
      api.emitWorkspaceEvent({
        version: 1,
        id: "20000000-0000-4000-8000-0000000000dc",
        type: "message.retracted",
        occurredAt: NOW,
        workspaceId: WORKSPACE_ID,
        conversationId: CONVERSATION_ID,
        workspaceSequence: "11",
        conversationSequence: hiddenMessage.conversationSequence,
        entityVersion: 2,
        delivery: "at_least_once",
        payload: { messageId: hiddenMessage.id, deletedAt: NOW },
      });
      await settle(
        () =>
          runtime.state.error === "Could not refresh unread counts after a message was deleted.",
        "failed source-less retract metadata refresh",
      );

      expect(runtime.state.stale).toBe(true);
      expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
        unreadCount: 1,
        mentionCount: 1,
      });
      expect(api.acknowledged).toEqual(["10", "11"]);
      expect(api.bootstrapRequests).toBe(2);

      const hydration = deferred<ListMessageReactionsResponse>();
      api.reactionResults.push(hydration.promise);
      const opening = runtime.openSearchResult({ message: ownMessage });
      await settle(() => api.reactionRequests.length === 1, "queued history hydration");

      await vi.advanceTimersByTimeAsync(999);
      expect(api.bootstrapRequests).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      // The retry must wait for the serialized history projection instead of replacing the cache
      // from an older load while this reaction hydration is still pending.
      expect(api.bootstrapRequests).toBe(2);

      hydration.resolve({ reactions: [] });
      await opening;
      await settle(
        () =>
          runtime.state.bootstrap?.conversations[0]?.unreadCount === 0 &&
          runtime.state.bootstrap?.conversations[0]?.mentionCount === 0 &&
          runtime.state.error === null,
        "retried source-less retract metadata refresh",
      );

      expect(runtime.state.stale).toBe(false);
      expect(api.bootstrapRequests).toBe(3);
      expect(api.acknowledged).toEqual(["10", "11"]);
      expect(runtime.state.messages).toContainEqual(ownMessage);
      await runtime.stop();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps source-less metadata pending when a concurrent cache write wins", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const hiddenMessage: Message = {
        ...threadReply,
        id: "20000000-0000-4000-8000-0000000000ea",
        clientMessageId: "20000000-0000-4000-8000-0000000000eb",
        conversationSequence: "3",
        body: "@morgan Hidden message to retract",
      };
      const laterMainMessage: Message = {
        ...ownMessage,
        id: "20000000-0000-4000-8000-0000000000dd",
        clientMessageId: "20000000-0000-4000-8000-0000000000de",
        conversationSequence: "5",
        body: "Later main-timeline message",
      };
      const beforeRetract = {
        ...channel(CONVERSATION_ID, "general"),
        participantIds: [USER_ID, PEER_ID],
        lastMessage: laterMainMessage,
        unreadCount: 1,
        mentionCount: 1,
      };
      const afterRetract = { ...beforeRetract, unreadCount: 0, mentionCount: 0 };
      const api = new FakeDesktopApi(
        bootstrapAt("10", { members: [user, peer], conversations: [beforeRetract] }),
      );
      const cache = new FakeWorkspaceCache();
      const runtime = runtimeWith(api, cache);
      await runtime.start(session);

      api.bootstrap = bootstrapAt("11", {
        members: [user, peer],
        conversations: [afterRetract],
      });
      const replacement = deferred<void>();
      cache.snapshotReplaceBarriers.push(replacement.promise);
      api.emitWorkspaceEvent({
        version: 1,
        id: "20000000-0000-4000-8000-0000000000df",
        type: "message.retracted",
        occurredAt: NOW,
        workspaceId: WORKSPACE_ID,
        conversationId: CONVERSATION_ID,
        workspaceSequence: "11",
        conversationSequence: hiddenMessage.conversationSequence,
        entityVersion: 2,
        delivery: "at_least_once",
        payload: { messageId: hiddenMessage.id, deletedAt: NOW },
      });
      await settle(
        () => cache.operations.filter((operation) => operation === "replaceSnapshot").length === 2,
        "source-less metadata replacement begins",
      );

      // A different local projection commits after the metadata cache read. The older catalog
      // must not satisfy the source-less retraction just because its replacement loses the race.
      await cache.advanceCursor("12");
      api.bootstrap = bootstrapAt("12", {
        members: [user, peer],
        conversations: [afterRetract],
      });
      replacement.resolve();
      await settle(
        () =>
          runtime.state.error === "Could not refresh unread counts after a message was deleted.",
        "stale source-less metadata replacement",
      );

      expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
        unreadCount: 1,
        mentionCount: 1,
      });
      expect(runtime.state.stale).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      await settle(
        () =>
          runtime.state.bootstrap?.conversations[0]?.unreadCount === 0 &&
          runtime.state.bootstrap?.conversations[0]?.mentionCount === 0 &&
          runtime.state.error === null,
        "source-less metadata retry after a concurrent cache write",
      );

      expect(runtime.state.stale).toBe(false);
      expect(api.bootstrapRequests).toBe(3);
      await runtime.stop();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not let a later source-less retract lose its invalidation to a full snapshot", async () => {
    const hiddenMessage: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000ec",
      clientMessageId: "20000000-0000-4000-8000-0000000000ed",
      conversationSequence: "3",
      body: "@morgan Hidden message to retract",
    };
    const latestThreadReply: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-0000000000ee",
      clientMessageId: "20000000-0000-4000-8000-0000000000ef",
      conversationSequence: "4",
      body: "Visible latest thread reply",
    };
    const laterMainMessage: Message = {
      ...ownMessage,
      id: "20000000-0000-4000-8000-0000000000e3",
      clientMessageId: "20000000-0000-4000-8000-0000000000e4",
      conversationSequence: "5",
      body: "Later main-timeline message",
    };
    const beforeRetract = {
      ...channel(CONVERSATION_ID, "general"),
      participantIds: [USER_ID, PEER_ID],
      lastMessage: laterMainMessage,
      unreadCount: 1,
      mentionCount: 1,
    };
    const afterRetract = { ...beforeRetract, unreadCount: 0, mentionCount: 0 };
    const api = new FakeDesktopApi(
      bootstrapAt("10", { members: [user, peer], conversations: [beforeRetract] }),
    );
    api.histories.set(CONVERSATION_ID, {
      messages: [latestThreadReply, laterMainMessage],
      threadSummaries: [
        { threadRootId: OWN_MESSAGE_ID, replyCount: 3, latestReply: latestThreadReply },
      ],
      threadsSupported: true,
      nextCursor: null,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    expect(runtime.state.threadSummaries).toEqual([
      { threadRootId: OWN_MESSAGE_ID, replyCount: 3, latestReply: latestThreadReply },
    ]);

    api.channelResults.push({ conversation: beforeRetract, syncCursor: "10" });
    const snapshotReload = deferred<void>();
    cache.loadBarriers.push(snapshotReload.promise);
    const archiving = runtime.archiveChannel(CONVERSATION_ID);
    await settle(() => {
      const replacements = cache.operations.filter(
        (operation) => operation === "replaceSnapshot",
      ).length;
      return replacements === 2 && cache.operations[cache.operations.length - 1] === "load";
    }, "full snapshot waits to reload its cache result");

    api.bootstrap = bootstrapAt("11", {
      members: [user, peer],
      conversations: [afterRetract],
    });
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000e5",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: hiddenMessage.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: hiddenMessage.id, deletedAt: NOW },
    });
    await settle(
      () =>
        runtime.state.bootstrap?.conversations[0]?.unreadCount === 0 &&
        runtime.state.threadSummaries.length === 0,
      "source-less retract metadata refresh while the snapshot reload waits",
    );

    snapshotReload.resolve();
    await archiving;

    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(runtime.state.threadSummaries).toEqual([]);
    expect((await cache.load()).bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
    });
  });

  it("projects idempotent reaction mutations and their realtime echoes", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    api.addReactionResults.push({ reaction: ownReaction, syncCursor: "11" });
    api.removeReactionResults.push({ removed: true, syncCursor: "12" });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.addReaction(OWN_MESSAGE_ID, "🎉");
    expect(runtime.state.reactions).toEqual([ownReaction]);
    expect(api.addedReactions).toEqual([{ messageId: OWN_MESSAGE_ID, emoji: "🎉" }]);

    api.emitWorkspaceEvent(reactionAddedEvent);
    await settle(() => api.acknowledged.includes("11"), "reaction-added acknowledgement");
    expect(runtime.state.reactions).toEqual([ownReaction]);

    await runtime.removeReaction(OWN_MESSAGE_ID, "🎉");
    expect(runtime.state.reactions).toEqual([]);
    expect(api.removedReactions).toEqual([{ messageId: OWN_MESSAGE_ID, emoji: "🎉" }]);

    api.emitWorkspaceEvent(reactionRemovedEvent);
    await settle(() => api.acknowledged.includes("12"), "reaction-removed acknowledgement");
    expect(runtime.state.reactions).toEqual([]);
    expect((await cache.load()).reactions).toEqual([]);
  });

  it("loads and mutates tasks while keeping newer optimistic versions over stale events", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    api.conversationTaskResults.push({ tasks: [task], nextCursor: null, hasMore: false });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    expect(api.conversationTaskRequests).toEqual([CONVERSATION_ID]);
    expect(runtime.state.tasks).toEqual([task]);

    api.conversationTaskResults.push({ tasks: [task], nextCursor: null, hasMore: false });
    await runtime.loadConversationTasks(CONVERSATION_ID);
    expect(api.conversationTaskRequests).toEqual([CONVERSATION_ID, CONVERSATION_ID]);
    expect(runtime.state.tasks).toEqual([task]);

    const updated: Task = {
      ...task,
      version: 2,
      title: "Build and verify the Kanban board",
      description: "Include keyboard moves.",
      updatedAt: "2026-07-24T12:02:00.000Z",
    };
    api.taskMutationResults.push({ task: updated, syncCursor: "12" });
    await runtime.updateTask(task.id, {
      title: updated.title,
      description: updated.description,
      priority: updated.priority,
      assigneeId: updated.assigneeId,
      dueOn: updated.dueOn,
    });
    expect(api.taskMutations[0]).toMatchObject({ taskId: task.id, expectedVersion: 1 });

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000015",
      type: "task.updated",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: task.version,
      delivery: "at_least_once",
      payload: { task },
    });
    await settle(() => api.acknowledged.includes("11"), "stale task event acknowledgement");
    expect(runtime.state.tasks).toEqual([updated]);
    expect((await cache.load()).tasks).toEqual([updated]);

    const moved: Task = {
      ...updated,
      version: 3,
      status: "in_progress",
      rank: "2048",
      updatedAt: "2026-07-24T12:03:00.000Z",
    };
    api.taskMutationResults.push({ task: moved, syncCursor: "13" });
    await runtime.moveTask(task.id, "in_progress", null);
    expect(api.taskMutations[1]).toMatchObject({
      taskId: task.id,
      expectedVersion: 2,
      status: "in_progress",
      beforeTaskId: null,
    });
    expect(runtime.state.tasks).toEqual([moved]);

    runtime.openTaskSource(moved);
    expect(runtime.state).toMatchObject({
      selectedConversationId: CONVERSATION_ID,
      focusedMessageId: OWN_MESSAGE_ID,
    });
  });

  it("keeps cached tasks until that conversation is opened on demand", async () => {
    const staleTask = { ...task, title: "Stale cached title" };
    const currentTask: Task = {
      ...task,
      version: 2,
      title: "Authoritative title",
      updatedAt: "2026-07-24T12:02:00.000Z",
    };
    const cache = new FakeWorkspaceCache();
    await cache.replaceSnapshot(bootstrapAt("9"), [], [], [staleTask]);
    const api = new FakeDesktopApi(bootstrapAt("12"));
    api.conversationTaskResults.push({
      tasks: [currentTask],
      nextCursor: null,
      hasMore: false,
    });
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(api.conversationTaskRequests).toEqual([]);
    expect(runtime.state.tasks).toEqual([staleTask]);
    await runtime.loadConversationTasks(CONVERSATION_ID);
    expect(runtime.state.tasks).toEqual([currentTask]);
    expect((await cache.load()).tasks).toEqual([currentTask]);
  });

  it("hydrates tasks only for channels and the signed-in user's self DM", async () => {
    const selfDmId = "20000000-0000-4000-8000-000000000030";
    const peerDmId = "20000000-0000-4000-8000-000000000031";
    const groupDmId = "20000000-0000-4000-8000-000000000032";
    const groupDm: ConversationSummary = {
      ...directConversation(groupDmId, [USER_ID, PEER_ID, AGENT_ID]),
      conversation: {
        ...directConversation(groupDmId, [USER_ID, PEER_ID, AGENT_ID]).conversation,
        kind: "group_direct_message",
      },
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [
          channel(CONVERSATION_ID, "general"),
          directConversation(selfDmId, [USER_ID]),
          directConversation(peerDmId, [USER_ID, PEER_ID]),
          groupDm,
        ],
      }),
    );
    const runtime = runtimeWith(api, new FakeWorkspaceCache());

    await runtime.start(session);

    expect(api.historyRequests).toEqual([CONVERSATION_ID, selfDmId, peerDmId, groupDmId]);
    expect(api.conversationTaskRequests).toEqual([CONVERSATION_ID, selfDmId]);
  });

  it.each([
    {
      label: "a page that claims more without a cursor",
      page: { tasks: [], nextCursor: null, hasMore: true },
    },
    {
      label: "a page that supplies a terminal cursor",
      page: { tasks: [], nextCursor: "task-page-1", hasMore: false },
    },
  ] satisfies { readonly label: string; readonly page: TaskListResponse }[])(
    "rejects $label before replacing the task snapshot",
    async ({ page }) => {
      const api = new FakeDesktopApi(bootstrapAt("10"));
      api.conversationTaskResults.push(page);
      const cache = new FakeWorkspaceCache();
      const runtime = runtimeWith(api, cache);

      await runtime.start(session);

      expect(cache.operations).not.toContain("replaceSnapshot");
      expect(runtime.state.bootstrap).toBeNull();
      expect(runtime.state.error).toBe("The workspace task catalog had inconsistent pagination");
      expect(api.startedCursors).toEqual([]);
    },
  );

  it("rejects an empty advancing task page instead of committing a partial snapshot", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.conversationTaskResults.push({
      tasks: [],
      nextCursor: "task-page-1",
      hasMore: true,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe("The workspace task catalog did not make progress");
  });

  it("rejects an empty terminal task continuation instead of accepting an incomplete page", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.conversationTaskResults.push(
      { tasks: [catalogTask(0)], nextCursor: "task-page-1", hasMore: true },
      { tasks: [], nextCursor: null, hasMore: false },
    );
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(api.conversationTaskPageRequests).toHaveLength(2);
    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe("The workspace task catalog did not make progress");
  });

  it("rejects a task cursor cycle without repeating requests", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.conversationTaskResults.push(
      { tasks: [catalogTask(0)], nextCursor: "task-page-1", hasMore: true },
      { tasks: [catalogTask(1)], nextCursor: "task-page-2", hasMore: true },
      { tasks: [catalogTask(2)], nextCursor: "task-page-1", hasMore: true },
    );
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(api.conversationTaskPageRequests.map((request) => request.after)).toEqual([
      undefined,
      "task-page-1",
      "task-page-2",
    ]);
    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe("The workspace task catalog did not advance its cursor");
  });

  it("rejects duplicate task IDs across catalog pages", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.conversationTaskResults.push(
      { tasks: [catalogTask(0)], nextCursor: "task-page-1", hasMore: true },
      { tasks: [catalogTask(0)], nextCursor: null, hasMore: false },
    );
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe("The workspace task catalog repeated a task");
  });

  it.each([
    {
      label: "workspace",
      task: catalogTask(0, CONVERSATION_ID, OTHER_WORKSPACE_ID),
      error: "The workspace task catalog crossed workspace scope",
    },
    {
      label: "conversation",
      task: catalogTask(0, SECOND_CONVERSATION_ID),
      error: "The workspace task catalog crossed conversation scope",
    },
  ])("rejects a task that crosses $label scope", async ({ task: wrongTask, error }) => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.conversationTaskResults.push({
      tasks: [wrongTask],
      nextCursor: null,
      hasMore: false,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe(error);
  });

  it("accepts a complete task catalog at the 20,000-task snapshot capacity", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    addTaskCatalogPages(api, WORKSPACE_SNAPSHOT_TASK_LIMIT);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(api.conversationTaskPageRequests).toHaveLength(WORKSPACE_SNAPSHOT_TASK_LIMIT / 200);
    expect(runtime.state.tasks).toHaveLength(WORKSPACE_SNAPSHOT_TASK_LIMIT);
    expect(cache.operations).toContain("replaceSnapshot");
    expect(runtime.state.error).toBeNull();
  });

  it("rejects a task catalog above the 20,000-task snapshot capacity", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    addTaskCatalogPages(api, WORKSPACE_SNAPSHOT_TASK_LIMIT + 1);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(api.conversationTaskPageRequests).toHaveLength(WORKSPACE_SNAPSHOT_TASK_LIMIT / 200);
    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe("The workspace task catalog exceeded local capacity");
  });

  it("keeps a task updated concurrently with a realtime membership refresh", async () => {
    const currentTask: Task = {
      ...task,
      version: 2,
      title: "Updated during membership repair",
      updatedAt: "2026-07-24T12:02:00.000Z",
    };
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.conversationTaskResults.push({ tasks: [task], nextCursor: null, hasMore: false });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    api.bootstrap = bootstrapAt("12");
    api.conversationTaskResults.push({
      tasks: [currentTask],
      nextCursor: null,
      hasMore: false,
    });
    api.emitWorkspaceEvent(membershipChanged(MEMBER_EVENT_ID, "11"));
    api.emitWorkspaceEvent(taskUpdated(SECOND_MEMBER_EVENT_ID, "12", currentTask));

    // The authoritative repair snapshot already contains the concurrent task update at cursor 12.
    // Restarting realtime retires the queued task frame from the old socket epoch, so the repaired
    // cursor is acknowledged once rather than applying and acknowledging that stale frame again.
    await settle(() => api.acknowledged.includes("12"), "membership snapshot acknowledgement");
    await drain();
    expect(api.acknowledged.filter((cursor) => cursor === "12")).toHaveLength(1);
    expect(cache.cursor).toBe("12");
    expect(runtime.state.tasks).toEqual([currentTask]);
    expect((await cache.load()).tasks).toEqual([currentTask]);
  });

  it("keeps a task updated after a membership event in the same HTTP catch-up page", async () => {
    const currentTask: Task = {
      ...task,
      version: 2,
      title: "Updated during HTTP membership repair",
      updatedAt: "2026-07-24T12:02:00.000Z",
    };
    const api = new FakeDesktopApi(bootstrapAt("12"));
    api.bootstrapResults.push(bootstrapAt("10"));
    api.conversationTaskResults.push(
      { tasks: [task], nextCursor: null, hasMore: false },
      { tasks: [currentTask], nextCursor: null, hasMore: false },
    );
    api.syncResults.push({
      status: "accepted",
      response: {
        events: [
          membershipChanged(MEMBER_EVENT_ID, "11"),
          taskUpdated(SECOND_MEMBER_EVENT_ID, "12", currentTask),
        ],
        nextCursor: "12",
        highWaterCursor: "12",
        hasMore: false,
      },
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    // The membership marker retires the rest of its page. The scoped transport is retired before
    // the final catch-up, so only the current scope can acknowledge the durable cursor.
    expect(api.syncedFrom).toEqual(["10", "12"]);
    expect(api.acknowledged).toEqual(["12"]);
    expect(api.startedCursors).toEqual(["12"]);
    expect(cache.cursor).toBe("12");
    expect(runtime.state.tasks).toEqual([currentTask]);
    expect((await cache.load()).tasks).toEqual([currentTask]);
  });

  it("keeps realtime events newer than an in-flight search reaction hydration", async () => {
    const cache = new FakeWorkspaceCache();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const hydration = deferred<ListMessageReactionsResponse>();
    api.reactionResults.push(hydration.promise);
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const opening = runtime.openSearchResult({ message: ownMessage });
    await settle(() => api.reactionRequests.length === 1, "search reaction hydration");
    api.emitWorkspaceEvent(reactionAddedEvent);
    hydration.resolve({ reactions: [] });

    await opening;
    await settle(() => api.acknowledged.includes("11"), "queued reaction event");
    expect(runtime.state.reactions).toEqual([ownReaction]);
    expect((await cache.load()).reactions).toEqual([ownReaction]);
  });

  it("keeps the realtime queue usable after a reaction projection fails", async () => {
    const cache = new FakeWorkspaceCache();
    cache.reactionUpsertFailures = 1;
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.addReactionResults.push({ reaction: ownReaction, syncCursor: "11" });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await expect(runtime.addReaction(OWN_MESSAGE_ID, "🎉")).rejects.toThrow(
      "encrypted reaction cache",
    );
    api.emitWorkspaceEvent(reactionAddedEvent);

    await settle(() => api.acknowledged.includes("11"), "reaction after cache failure");
    expect(runtime.state.reactions).toEqual([ownReaction]);
    expect((await cache.load()).reactions).toEqual([ownReaction]);
  });

  it("keeps an abandoned failed-message edit recoverable across a restart", async () => {
    const cache = new FakeWorkspaceCache();
    await enqueuePermanentFailure(cache, OWN_CLIENT_MESSAGE_ID, "Authored while offline");
    const firstRuntime = runtimeWith(new FakeDesktopApi(bootstrapAt("10")), cache);
    await firstRuntime.start(session);

    // Entering edit mode only copies this durable body into renderer state; it deliberately makes
    // no runtime/cache mutation until a replacement is submitted.
    expect(firstRuntime.state.outbox[0]?.operation.message.body).toBe("Authored while offline");
    await firstRuntime.stop();

    const restarted = runtimeWith(new FakeDesktopApi(bootstrapAt("10")), cache);
    await restarted.start(session);
    expect(restarted.state.outbox).toHaveLength(1);
    expect(restarted.state.outbox[0]?.operation.message.body).toBe("Authored while offline");
    expect(restarted.state.outbox[0]?.status).toBe("permanent_failure");
  });

  it("durably queues a fresh replacement before removing the failed predecessor", async () => {
    const cache = new FakeWorkspaceCache();
    await enqueuePermanentFailure(cache, OWN_CLIENT_MESSAGE_ID, "Original body");
    cache.outboxMutations.length = 0;
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.sendResults.push({ status: "permanent", reason: "validation" });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.replaceFailedMessage(OWN_CLIENT_MESSAGE_ID, "Replacement body", []);
    await settle(
      () =>
        runtime.state.outbox[0]?.status === "permanent_failure" &&
        runtime.state.outbox[0]?.operation.message.clientMessageId !== OWN_CLIENT_MESSAGE_ID,
      "replacement failure",
    );

    const durableOutbox = (await cache.load()).outbox.filter(
      (item) => item.operation.conversationId === CONVERSATION_ID,
    );
    expect(durableOutbox).toHaveLength(1);
    const replacement = durableOutbox[0];
    expect(replacement?.operation.message.body).toBe("Replacement body");
    expect(replacement?.operation.message.clientMessageId).not.toBe(OWN_CLIENT_MESSAGE_ID);
    expect(replacement?.operation.idempotencyKey).toBe(
      replacement?.operation.message.clientMessageId,
    );
    expect(
      durableOutbox.some(
        (item) => item.operation.message.clientMessageId === OWN_CLIENT_MESSAGE_ID,
      ),
    ).toBe(false);
    expect(cache.outboxMutations.map((mutation) => mutation.type)).toEqual(["enqueue", "remove"]);
    expect(cache.outboxMutations[0]?.clientMessageId).toBe(
      replacement?.operation.message.clientMessageId,
    );
    expect(cache.outboxMutations[1]?.clientMessageId).toBe(OWN_CLIENT_MESSAGE_ID);
  });

  it("keeps a failed replacement in its predecessor's per-conversation FIFO position", async () => {
    const cache = new FakeWorkspaceCache();
    await enqueuePermanentFailure(cache, OWN_CLIENT_MESSAGE_ID, "Original body");
    const laterClientMessageId = "20000000-0000-4000-8000-000000000011";
    await cache.replaceSnapshot(bootstrapAt("0"), []);
    await cache.enqueue(
      queuedOperation(laterClientMessageId, "Later body"),
      "2026-07-24T12:00:00.001Z",
    );
    await cache.clearServerStatePreservingOutbox();
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.sendResults.push({ status: "permanent", reason: "validation" });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.replaceFailedMessage(OWN_CLIENT_MESSAGE_ID, "Replacement body", []);
    await settle(
      () => runtime.state.outbox[0]?.status === "permanent_failure",
      "replacement failure",
    );

    const inMemoryBodies = runtime.state.outbox
      .filter((item) => item.operation.conversationId === CONVERSATION_ID)
      .map((item) => item.operation.message.body);
    const durableBodies = (await cache.load()).outbox
      .filter((item) => item.operation.conversationId === CONVERSATION_ID)
      .map((item) => item.operation.message.body);
    expect(inMemoryBodies).toEqual(["Replacement body", "Later body"]);
    expect(durableBodies).toEqual(["Replacement body", "Later body"]);
  });

  it("still discards a failed message immediately and durably", async () => {
    const cache = new FakeWorkspaceCache();
    await enqueuePermanentFailure(cache, OWN_CLIENT_MESSAGE_ID, "Discard me");
    const runtime = runtimeWith(new FakeDesktopApi(bootstrapAt("10")), cache);
    await runtime.start(session);

    await runtime.discardMessage(OWN_CLIENT_MESSAGE_ID);
    expect(runtime.state.outbox).toEqual([]);
    expect((await cache.load()).outbox).toEqual([]);
    await runtime.stop();

    const restarted = runtimeWith(new FakeDesktopApi(bootstrapAt("10")), cache);
    await restarted.start(session);
    expect(restarted.state.outbox).toEqual([]);
  });

  it("restarts realtime with the cursor a resync established, and does not loop", async () => {
    const api = new FakeDesktopApi(bootstrapAt("5"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    expect(api.startedCursors).toEqual(["5"]);
    expect(api.bootstrapRequests).toBe(1);

    // The server restored the workspace: the client cursor is unusable and the socket is closed.
    api.bootstrap = bootstrapAt("40");
    api.emitWorkspaceEvent(resyncRequired);
    await settle(() => api.startedCursors.length === 2, "realtime restart after resync");

    expect(api.stopRequests).toBe(2);
    expect(api.startedCursors).toEqual(["5", "40"]);
    expect(api.bootstrapRequests).toBe(2);
    expect(cache.cursor).toBe("40");
    // One resync must not turn into a repeating download of the whole workspace.
    await drain();
    expect(api.bootstrapRequests).toBe(2);
    expect(api.startedCursors).toEqual(["5", "40"]);
  });

  it("does not let an older retry settle a newer resync demand", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const api = new FakeDesktopApi(bootstrapAt("5"));
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);

      const olderRetry = deferred<HumanWorkspaceBootstrapResponse>();
      api.bootstrap = bootstrapAt("50");
      api.bootstrapFailures = 1;
      api.bootstrapResults.push(olderRetry.promise);
      api.emitWorkspaceEvent(resyncRequired);
      await settle(() => runtime.state.error !== null, "failed first resync attempt");

      // The timer retry reaches its bootstrap request and stalls. A demand that arrives after the
      // old scoped transport was retired is stale and must not start a second recovery owner.
      await vi.advanceTimersByTimeAsync(1_000);
      await settle(() => api.bootstrapRequests === 3, "stalled older resync retry");
      api.emitWorkspaceEvent(resyncRequired);
      olderRetry.resolve(bootstrapAt("40"));

      expect(api.startedCursors).toEqual(["5"]);
      expect(runtime.state.stale).toBe(true);

      await settle(() => api.startedCursors.length === 2, "older resync recovery");
      expect(api.startedCursors).toEqual(["5", "40"]);
      await settle(() => !runtime.state.stale, "settled older resync recovery");
      expect(runtime.state.stale).toBe(false);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("serializes an in-flight sync retry with a realtime resync demand", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("10"));
      api.syncResults.push({ status: "retryable", reason: "server", retryAfterMs: 1_000 });
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);

      const olderSync = deferred<SyncAttemptResult>();
      api.syncResults.push(olderSync.promise);
      await vi.advanceTimersByTimeAsync(1_000);
      await settle(() => api.syncedFrom.length === 2, "in-flight sync retry");

      api.bootstrap = bootstrapAt("40");
      api.emitWorkspaceEvent(resyncRequired);
      await drain();

      // Startup has not attached realtime while durable catch-up is retrying. The synthetic resync
      // demand still stops the transport boundary immediately, but its cache recovery stays queued
      // behind the timer retry instead of starting a second repair pass.
      expect(api.stopRequests).toBe(2);
      expect(api.bootstrapRequests).toBe(1);
      expect(api.startedCursors).toEqual([]);
      expect(runtime.state.stale).toBe(true);

      olderSync.resolve({
        status: "accepted",
        response: {
          events: [],
          nextCursor: "10",
          highWaterCursor: "10",
          hasMore: false,
        },
      });
      await settle(() => api.startedCursors.length === 2, "serialized resync recovery");
      await settle(() => !runtime.state.stale, "settled serialized resync recovery");
      expect(api.startedCursors).toEqual(["10", "40"]);
      expect(runtime.state.stale).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a resync chain whose handshakes each report the connection live", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("5"));
      // A restored workspace whose cursor sits below the oldest retained event answers every
      // handshake this way: the socket comes up live and the demand follows from a later flush, so
      // `system.connected` says nothing about the cursor and cannot end the chain.
      api.connectedOnStart = true;
      api.resyncOnStart = true;
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);
      await settle(() => api.bootstrapRequests === 2, "first resync download");

      // The repeat waits for a backoff instead of re-downloading as fast as the server rejects it.
      await drain();
      expect(api.bootstrapRequests).toBe(2);

      for (let round = 0; round < 12 && runtime.state.error === null; round += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        await drain();
      }
      const downloads = api.bootstrapRequests;
      expect(runtime.state.error).toBe(
        "The server keeps asking this device to resync. Reset the local cache.",
      );
      expect(runtime.state.stale).toBe(true);
      // Bounded: a handful of downloads, then the dead end is reported instead of retried.
      expect(downloads).toBeLessThanOrEqual(4);

      for (let round = 0; round < 4; round += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        await drain();
      }
      expect(api.bootstrapRequests).toBe(downloads);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a resync whose download failed instead of wedging the client", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("5"));
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);

      // One genuine demand, then a server that is briefly unavailable: a 502 for a few seconds is
      // not a server demanding resyncs, and it must not spend a budget meant for that.
      api.bootstrap = bootstrapAt("40");
      api.bootstrapFailures = 3;
      api.emitWorkspaceEvent(resyncRequired);
      await settle(() => runtime.state.error !== null, "failed resync surfaces");

      // The notice is the failure that happened, not a resync loop the server never asked for.
      expect(runtime.state.error).toBe("The workspace is temporarily unavailable");
      // Realtime is stopped and the cached workspace is gone, so only the retry can heal this.
      expect(api.startedCursors).toEqual(["5"]);

      for (let round = 0; round < 6 && api.startedCursors.length === 1; round += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        await drain();
      }
      expect(api.startedCursors).toEqual(["5", "40"]);
      expect(runtime.state.error).toBeNull();
      expect(runtime.state.stale).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies an in-flight lower-sequence peer event after a send is accepted", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    // The send is allocated workspace sequence 12 while a peer's event 11 is still in flight.
    api.sendResults.push({
      status: "accepted",
      response: { message: ownMessage, attachments: [], syncCursor: "12" },
    });
    await runtime.sendMessage(CONVERSATION_ID, "Mine", []);
    await settle(() => runtime.state.outbox.length === 0, "send acknowledgement");

    expect(cache.cursor).toBe("10");
    expect(api.acknowledged).not.toContain("12");

    api.emitWorkspaceEvent(peerEvent);
    await settle(
      () => runtime.state.messages.some((item) => item.id === PEER_MESSAGE_ID),
      "peer message application",
    );

    const ids = runtime.state.messages.map((item) => item.id);
    expect(ids).toContain(PEER_MESSAGE_ID);
    expect(ids).toContain(OWN_MESSAGE_ID);
    expect(runtime.state.bootstrap?.conversations[0]?.unreadCount).toBe(1);
  });

  it("sends attachment ids and hydrates files from history and live messages", async () => {
    const attachment: Attachment = {
      id: "20000000-0000-4000-8000-0000000000aa",
      messageId: OWN_MESSAGE_ID,
      uploadedBy: USER_ID,
      fileName: "launch-notes.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
      status: "ready",
      downloadUrl: null,
      createdAt: NOW,
    };
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [],
      threadsSupported: true,
      attachments: [attachment],
      nextCursor: null,
    });
    api.sendResults.push({
      status: "accepted",
      response: {
        message: { ...ownMessage, id: "20000000-0000-4000-8000-0000000000ab" },
        attachments: [
          {
            ...attachment,
            id: "20000000-0000-4000-8000-0000000000ac",
            messageId: "20000000-0000-4000-8000-0000000000ab",
          },
        ],
        syncCursor: "11",
      },
    });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    expect(runtime.state.attachments).toEqual([attachment]);

    await runtime.sendMessage(CONVERSATION_ID, "Notes", [], null, [attachment.id]);
    await settle(() => runtime.state.outbox.length === 0, "attached send acknowledgement");
    expect(api.sent[0]?.message.attachmentIds).toEqual([attachment.id]);
    expect(runtime.state.attachments.map((item) => item.fileName)).toContain("launch-notes.pdf");

    const liveAttachment: Attachment = {
      ...attachment,
      id: "20000000-0000-4000-8000-0000000000ad",
      messageId: PEER_MESSAGE_ID,
      fileName: "dm-clip.webm",
    };
    api.attachmentResults.push({ attachments: [liveAttachment] });
    api.emitWorkspaceEvent(peerEvent);
    await settle(
      () => runtime.state.attachments.some((item) => item.id === liveAttachment.id),
      "live attachment hydration",
    );
    expect(runtime.state.attachments.some((item) => item.fileName === "dm-clip.webm")).toBe(true);

    api.conversationFileResults.push({
      files: [attachment, liveAttachment],
      nextCursor: null,
      hasMore: false,
    });
    await runtime.loadConversationFiles(CONVERSATION_ID);
    expect(runtime.state.conversationFiles).toEqual([attachment, liveAttachment]);
  });

  it("counts out-of-order replies once across HTTP and realtime delivery", async () => {
    const earlierReply: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-000000000022",
      clientMessageId: "20000000-0000-4000-8000-000000000023",
      conversationSequence: "4",
      body: "Earlier reply A",
    };
    const laterReply: Message = {
      ...threadReply,
      id: "20000000-0000-4000-8000-000000000024",
      clientMessageId: "20000000-0000-4000-8000-000000000025",
      conversationSequence: "5",
      body: "Later reply B",
    };
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.histories.set(CONVERSATION_ID, {
      messages: [ownMessage],
      threadSummaries: [{ threadRootId: OWN_MESSAGE_ID, replyCount: 1, latestReply: threadReply }],
      threadsSupported: true,
      nextCursor: null,
    });
    api.sendResults.push({
      status: "accepted",
      response: { message: laterReply, syncCursor: "12" },
    });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    await runtime.sendMessage(CONVERSATION_ID, laterReply.body, [], OWN_MESSAGE_ID);
    await settle(
      () => runtime.state.threadSummaries[0]?.latestReply.id === laterReply.id,
      "later HTTP reply projection",
    );

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000026",
      type: "message.created",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: earlierReply.conversationSequence,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { message: earlierReply, mentionedUserIds: [] },
    });
    await settle(
      () => runtime.state.messages.some((message) => message.id === earlierReply.id),
      "earlier realtime reply projection",
    );

    expect(runtime.state.threadSummaries[0]).toMatchObject({
      replyCount: 3,
      latestReply: { id: laterReply.id },
    });

    const sentClientMessageId = api.sent[0]?.message.clientMessageId;
    if (sentClientMessageId === undefined) throw new Error("Expected the reply send operation");
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000027",
      type: "message.created",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "12",
      conversationSequence: laterReply.conversationSequence,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: {
        message: { ...laterReply, clientMessageId: sentClientMessageId },
        mentionedUserIds: [],
      },
    });
    await settle(() => api.acknowledged.includes("12"), "later realtime reply echo");

    expect(runtime.state.threadSummaries[0]).toMatchObject({
      replyCount: 3,
      latestReply: { id: laterReply.id },
    });
  });

  it("projects canonical unread counts from read-cursor events", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [
          {
            ...channel(CONVERSATION_ID, "general"),
            unreadCount: 4,
            mentionCount: 3,
          },
        ],
      }),
    );
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-00000000000e",
      type: "read_cursor.updated",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: {
        readCursor: {
          conversationId: CONVERSATION_ID,
          userId: USER_ID,
          lastReadMessageId: PEER_MESSAGE_ID,
          lastReadConversationSequence: "1",
          lastReadAt: NOW,
          updatedAt: NOW,
        },
        unreadCount: 1,
        mentionCount: 1,
      },
    });
    await settle(
      () => runtime.state.bootstrap?.conversations[0]?.unreadCount === 1,
      "read cursor projection",
    );

    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 1,
      mentionCount: 1,
      readCursor: { lastReadMessageId: PEER_MESSAGE_ID },
    });
  });

  it("does not erase counts when a retained legacy read-cursor event replays", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [
          {
            ...channel(CONVERSATION_ID, "general"),
            unreadCount: 4,
            mentionCount: 3,
          },
        ],
      }),
    );
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-00000000000f",
      type: "read_cursor.updated",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: {
        readCursor: {
          conversationId: CONVERSATION_ID,
          userId: USER_ID,
          lastReadMessageId: PEER_MESSAGE_ID,
          lastReadConversationSequence: "1",
          lastReadAt: NOW,
          updatedAt: NOW,
        },
      },
    });
    await settle(
      () => runtime.state.bootstrap?.conversations[0]?.readCursor !== null,
      "legacy read cursor projection",
    );

    expect(runtime.state.bootstrap?.conversations[0]).toMatchObject({
      unreadCount: 4,
      mentionCount: 3,
      readCursor: { lastReadMessageId: PEER_MESSAGE_ID },
    });
  });

  it("projects and selects a created channel without refreshing or skipping earlier events", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    const bootstrapRequestsAfterStart = api.bootstrapRequests;
    const historyRequestsAfterStart = api.historyRequests.length;
    const createdSummary = channel(CREATED_CHANNEL_ID, "alpha-team");
    api.channelResults.push({
      conversation: {
        ...createdSummary,
        conversation: { ...createdSummary.conversation, name: "Alpha Team" },
      },
      syncCursor: "12",
    });

    await runtime.createChannel(
      "Alpha Team",
      "alpha-team",
      "Coordinate work across the alpha launch.",
      "workspace",
    );

    expect(api.createdChannels).toEqual([
      {
        name: "Alpha Team",
        slug: "alpha-team",
        topic: "Coordinate work across the alpha launch.",
        access: "workspace",
        idempotencyKey: expect.any(String),
      },
    ]);
    expect(api.bootstrapRequests).toBe(bootstrapRequestsAfterStart);
    expect(api.historyRequests).toHaveLength(historyRequestsAfterStart);
    expect(runtime.state.selectedConversationId).toBe(CREATED_CHANNEL_ID);
    expect(runtime.state.bootstrap?.conversations.map((item) => item.conversation.slug)).toEqual([
      "alpha-team",
      "general",
    ]);
    expect(
      (await cache.load()).bootstrap?.conversations.map((item) => item.conversation.slug),
    ).toContain("alpha-team");
    await runtime.loadOlder(CREATED_CHANNEL_ID);
    expect(api.historyRequests).toHaveLength(historyRequestsAfterStart);

    // The mutation's cursor is a high-water mark, not proof that every earlier event is cached.
    expect(cache.cursor).toBe("10");
    expect(api.acknowledged).not.toContain("12");
    api.emitWorkspaceEvent(peerEvent);
    await settle(
      () => runtime.state.messages.some((item) => item.id === PEER_MESSAGE_ID),
      "earlier peer event after channel creation",
    );
    expect(runtime.state.messages.map((item) => item.id)).toContain(PEER_MESSAGE_ID);
  });

  it("rejects channel creation before bootstrap without contacting the server", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const runtime = runtimeWith(api, new FakeWorkspaceCache());

    await expect(runtime.createChannel("Too Soon", "too-soon", null, "members")).rejects.toThrow(
      "Workspace is still loading",
    );
    expect(api.createdChannels).toEqual([]);
  });

  it("does not project a successful mutation into a replacement session", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    let resolveResult: ((result: ConversationMutationResponse) => void) | undefined;
    api.channelResults.push(
      new Promise((resolve) => {
        resolveResult = resolve;
      }),
    );
    const creation = runtime.createChannel("Alpha Team", "alpha-team", null, "workspace");
    await settle(() => api.createdChannels.length === 1, "channel request");
    await runtime.stop();
    const createdSummary = channel(CREATED_CHANNEL_ID, "alpha-team");
    resolveResult?.({ conversation: createdSummary, syncCursor: "12" });

    await expect(creation).resolves.toBeUndefined();
    expect(runtime.state.bootstrap).toBeNull();
  });

  it("clears the old workspace synchronously while a replacement identity bootstrap is pending", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const firstCache = new FakeWorkspaceCache();
    const replacementCache = new FakeWorkspaceCache();
    const runtime = new WorkspaceRuntime(api, {
      createCache: (status) =>
        status.scope.userId === OTHER_USER_ID ? replacementCache : firstCache,
    });
    await runtime.start(session);
    expect(runtime.state.bootstrap?.currentUser.user.id).toBe(USER_ID);

    const replacementBootstrap = deferred<HumanWorkspaceBootstrapResponse>();
    api.cryptoStatus = {
      mode: "memory_only",
      scope: { userId: OTHER_USER_ID, workspaceId: OTHER_WORKSPACE_ID },
      reason: "credential_store_unavailable",
    };
    api.bootstrapResults.push(replacementBootstrap.promise);
    const replacement = runtime.start(otherSession);

    expect(runtime.state).toMatchObject({
      bootstrap: null,
      messages: [],
      outbox: [],
      selectedConversationId: null,
      busy: true,
    });
    await drain();
    expect(runtime.state.bootstrap).toBeNull();

    replacementBootstrap.resolve(otherBootstrapAt("20"));
    await replacement;
    expect(runtime.state.bootstrap?.currentUser.user.id).toBe(OTHER_USER_ID);
  });

  it("does not let delayed old-scope cache initialization replace the current cache", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const delayedCrypto = deferred<CacheCryptoStatus>();
    api.cryptoStatusResults.push(delayedCrypto.promise, {
      mode: "memory_only",
      scope: { userId: OTHER_USER_ID, workspaceId: OTHER_WORKSPACE_ID },
      reason: "credential_store_unavailable",
    });
    const firstCache = new FakeWorkspaceCache();
    const replacementCache = new FakeWorkspaceCache();
    const runtime = new WorkspaceRuntime(api, {
      createCache: (status) =>
        status.scope.userId === OTHER_USER_ID ? replacementCache : firstCache,
    });

    const firstStart = runtime.start(session);
    await drain();
    api.bootstrap = otherBootstrapAt("20");
    await runtime.start(otherSession);

    delayedCrypto.resolve({
      mode: "memory_only",
      scope,
      reason: "credential_store_unavailable",
    });
    await firstStart;

    expect(firstCache.loadCount).toBe(0);
    expect(replacementCache.loadCount).toBeGreaterThan(0);
    expect(runtime.state.bootstrap?.currentUser.user.id).toBe(OTHER_USER_ID);
    expect(runtime.state.bootstrap?.workspace.id).toBe(OTHER_WORKSPACE_ID);
  });

  it("does not publish a delayed old-cache reload after a replacement scope starts", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const firstCache = new FakeWorkspaceCache();
    await firstCache.replaceSnapshot(bootstrapAt("10"), [ownMessage]);
    const delayedReload = deferred<void>();
    firstCache.loadBarriers.push(Promise.resolve(), Promise.resolve(), delayedReload.promise);
    const replacementCache = new FakeWorkspaceCache();
    const runtime = new WorkspaceRuntime(api, {
      createCache: (status) =>
        status.scope.userId === OTHER_USER_ID ? replacementCache : firstCache,
    });

    const firstStart = runtime.start(session);
    await settle(() => firstCache.loadCount === 3, "old cache reload");

    api.cryptoStatus = {
      mode: "memory_only",
      scope: { userId: OTHER_USER_ID, workspaceId: OTHER_WORKSPACE_ID },
      reason: "credential_store_unavailable",
    };
    api.bootstrap = otherBootstrapAt("20");
    await runtime.start(otherSession);
    expect(runtime.state.bootstrap?.currentUser.user.id).toBe(OTHER_USER_ID);

    delayedReload.resolve();
    await firstStart;
    await drain();

    expect(runtime.state.bootstrap?.currentUser.user.id).toBe(OTHER_USER_ID);
    expect(runtime.state.bootstrap?.workspace.id).toBe(OTHER_WORKSPACE_ID);
    expect(runtime.state.messages).toEqual([]);
  });

  it("keeps a server-created channel selected when its cache write fails", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    cache.upsertFailure = new Error("disk full");
    const createdSummary = channel(CREATED_CHANNEL_ID, "alpha-team");
    api.channelResults.push({ conversation: createdSummary, syncCursor: "12" });

    await expect(
      runtime.createChannel("Alpha Team", "alpha-team", null, "workspace"),
    ).resolves.toBeUndefined();
    expect(runtime.state.selectedConversationId).toBe(CREATED_CHANNEL_ID);
    expect(runtime.state.bootstrap?.conversations).toContainEqual(createdSummary);
    expect(runtime.state.stale).toBe(true);
    expect(runtime.state.error).toMatch(/local cache needs repair/);
    expect(cache.cursor).toBe("10");
  });

  it("opens a cached direct message immediately without a snapshot or history refresh", async () => {
    const peerDm = directConversation(DIRECT_CONVERSATION_ID, [USER_ID, PEER_ID]);
    const cachedDirectMessage: Message = {
      ...peerMessage,
      id: DIRECT_MESSAGE_ID,
      clientMessageId: DIRECT_CLIENT_MESSAGE_ID,
      conversationId: DIRECT_CONVERSATION_ID,
      body: "Cached CPO thread",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        members: [user, peer],
        conversations: [channel(CONVERSATION_ID, "general"), peerDm],
      }),
    );
    api.histories.set(DIRECT_CONVERSATION_ID, {
      messages: [cachedDirectMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);
    const bootstrapRequestsAfterStart = api.bootstrapRequests;
    const historyRequestsAfterStart = api.historyRequests.length;
    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.messages).toContainEqual(cachedDirectMessage);

    await runtime.createDirectConversation(PEER_ID);

    expect(api.createdDirectConversations).toEqual([]);
    expect(api.bootstrapRequests).toBe(bootstrapRequestsAfterStart);
    expect(api.historyRequests).toHaveLength(historyRequestsAfterStart);
    expect(runtime.state.selectedConversationId).toBe(DIRECT_CONVERSATION_ID);
    expect(
      runtime.state.messages.filter((item) => item.conversationId === DIRECT_CONVERSATION_ID),
    ).toEqual([cachedDirectMessage]);

    runtime.selectConversation(CONVERSATION_ID);
    runtime.selectConversation(DIRECT_CONVERSATION_ID);
    expect(api.bootstrapRequests).toBe(bootstrapRequestsAfterStart);
    expect(api.historyRequests).toHaveLength(historyRequestsAfterStart);
    expect(runtime.state.selectedConversationId).toBe(DIRECT_CONVERSATION_ID);
  });

  it("projects a new direct message and hydrates its history after first paint", async () => {
    const createdDm = directConversation(DIRECT_CONVERSATION_ID, [USER_ID, PEER_ID]);
    const hydratedMessage: Message = {
      ...peerMessage,
      id: DIRECT_MESSAGE_ID,
      clientMessageId: DIRECT_CLIENT_MESSAGE_ID,
      conversationId: DIRECT_CONVERSATION_ID,
      body: "Hydrated after first paint",
    };
    const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, peer] }));
    const delayedHistory = deferred<MessageHistoryResponse>();
    api.directConversationResults.push({ conversation: createdDm, syncCursor: "12" });
    api.historyResults.set(DIRECT_CONVERSATION_ID, [delayedHistory.promise]);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    const bootstrapRequestsAfterStart = api.bootstrapRequests;
    const historyRequestsAfterStart = api.historyRequests.length;

    const opening = runtime.createDirectConversation(PEER_ID);
    await settle(() => api.createdDirectConversations.length === 1, "direct conversation request");
    await opening;

    expect(api.createdDirectConversations).toEqual([PEER_ID]);
    expect(api.bootstrapRequests).toBe(bootstrapRequestsAfterStart);
    expect(runtime.state.selectedConversationId).toBe(DIRECT_CONVERSATION_ID);
    expect(runtime.state.bootstrap?.conversations.map((item) => item.conversation.id)).toEqual([
      CONVERSATION_ID,
      DIRECT_CONVERSATION_ID,
    ]);
    expect(
      runtime.state.messages.filter((item) => item.conversationId === DIRECT_CONVERSATION_ID),
    ).toEqual([]);
    await settle(
      () => api.historyRequests.length === historyRequestsAfterStart + 1,
      "lazy direct-message history fetch",
    );
    expect(api.historyRequests.at(-1)).toBe(DIRECT_CONVERSATION_ID);

    delayedHistory.resolve({
      messages: [hydratedMessage],
      threadSummaries: [],
      threadsSupported: true,
      attachments: [],
      nextCursor: null,
    });
    await settle(
      () => runtime.state.messages.some((item) => item.id === DIRECT_MESSAGE_ID),
      "lazy-hydrated direct-message history",
    );
    expect(
      runtime.state.messages.filter((item) => item.conversationId === DIRECT_CONVERSATION_ID),
    ).toEqual([hydratedMessage]);
    expect(
      (await cache.load()).bootstrap?.conversations.map((item) => item.conversation.id),
    ).toContain(DIRECT_CONVERSATION_ID);
    expect((await cache.load()).messages).toContainEqual(hydratedMessage);
  });

  it("rejects direct-message creation before bootstrap without contacting the server", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, peer] }));
    const runtime = runtimeWith(api, new FakeWorkspaceCache());

    await expect(runtime.createDirectConversation(PEER_ID)).rejects.toThrow(
      "Workspace is still loading",
    );
    expect(api.createdDirectConversations).toEqual([]);
  });

  it("does not project a successful direct conversation into a replacement session", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, peer] }));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    let resolveResult: ((result: ConversationMutationResponse) => void) | undefined;
    api.directConversationResults.push(
      new Promise((resolve) => {
        resolveResult = resolve;
      }),
    );
    const opening = runtime.createDirectConversation(PEER_ID);
    await settle(() => api.createdDirectConversations.length === 1, "direct conversation request");
    await runtime.stop();
    resolveResult?.({
      conversation: directConversation(DIRECT_CONVERSATION_ID, [USER_ID, PEER_ID]),
      syncCursor: "12",
    });

    await expect(opening).resolves.toBeUndefined();
    expect(runtime.state.bootstrap).toBeNull();
    expect(runtime.state.selectedConversationId).toBeNull();
  });

  it("rearms the retry timer so a retryable send is redelivered with no user action", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("10"));
      const cache = new FakeWorkspaceCache();
      const runtime = runtimeWith(api, cache);
      await runtime.start(session);
      api.sendResults.push({ status: "retryable", reason: "network", retryAfterMs: 5_000 });
      api.sendResults.push({
        status: "accepted",
        response: { message: ownMessage, attachments: [], syncCursor: "11" },
      });

      await runtime.sendMessage(CONVERSATION_ID, "Mine", []);
      await settle(() => runtime.state.outbox[0]?.status === "retry_wait", "retry wait");
      expect(api.sent).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await settle(() => api.sent.length === 2, "automatic redelivery");
      expect(runtime.state.outbox).toEqual([]);
      expect(runtime.state.messages.map((item) => item.id)).toContain(OWN_MESSAGE_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a replacement generation flush while the retired send remains hung", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const hungSend = deferred<SendAttemptResult>();
    api.sendResults.push(hungSend.promise, {
      status: "accepted",
      response: { message: ownMessage, attachments: [], syncCursor: "11" },
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.sendMessage(CONVERSATION_ID, "Mine", []);
    await settle(() => api.sent.length === 1, "retired generation send");

    const restarted = runtime.start(session);
    await settle(() => api.sent.length === 2, "replacement generation send");
    await restarted;

    expect(api.sent[0]?.message.clientMessageId).toBe(api.sent[1]?.message.clientMessageId);
    expect(runtime.state.outbox).toEqual([]);
    expect(runtime.state.messages.map((message) => message.id)).toContain(OWN_MESSAGE_ID);

    hungSend.resolve({
      status: "accepted",
      response: { message: ownMessage, attachments: [], syncCursor: "11" },
    });
    await drain();

    expect(api.sent).toHaveLength(2);
    expect(runtime.state.messages.filter((message) => message.id === OWN_MESSAGE_ID)).toHaveLength(
      1,
    );
  });

  it("does not let a retired flush adopt the replacement while a status patch is delayed", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [
          channel(CONVERSATION_ID, "general"),
          channel(SECOND_CONVERSATION_ID, "random"),
        ],
      }),
    );
    const delayedPermanentPatch = deferred<void>();
    const replacementSend = deferred<SendAttemptResult>();
    const secondMessage: Message = {
      ...ownMessage,
      id: "20000000-0000-4000-8000-000000000085",
      clientMessageId: "20000000-0000-4000-8000-000000000086",
      conversationId: SECOND_CONVERSATION_ID,
      conversationSequence: "1",
    };
    api.sendResults.push({ status: "permanent", reason: "validation" }, replacementSend.promise, {
      status: "accepted",
      response: { message: secondMessage, syncCursor: "12" },
    });
    const cache = new FakeWorkspaceCache();
    cache.outboxUpdateBarriers.push(Promise.resolve(), delayedPermanentPatch.promise);
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.sendMessage(CONVERSATION_ID, "Old owner", []);
    await settle(() => cache.outboxUpdateAttempts === 2, "delayed permanent status patch");
    expect(api.sent).toHaveLength(1);
    const retiredClientMessageId = api.sent[0]?.message.clientMessageId;
    if (retiredClientMessageId === undefined) throw new Error("Expected the retired send");
    await runtime.sendMessage(SECOND_CONVERSATION_ID, "Current owner", []);

    const restarted = runtime.start(session);
    await settle(() => api.sent.length === 2, "replacement send while old patch is delayed");

    delayedPermanentPatch.resolve();
    await drain();
    expect(api.sent).toHaveLength(2);
    expect(
      (await cache.load()).outbox.find(
        (item) => item.operation.message.clientMessageId === retiredClientMessageId,
      ),
    ).toMatchObject({ status: "sending", attemptCount: 2 });

    replacementSend.resolve({
      status: "accepted",
      response: { message: ownMessage, attachments: [], syncCursor: "11" },
    });
    await settle(() => api.sent.length === 3, "replacement owner second conversation send");
    await restarted;

    expect(api.sent[2]?.conversationId).toBe(SECOND_CONVERSATION_ID);
    expect(runtime.state.outbox).toEqual([]);
    expect((await cache.load()).outbox).toEqual([]);
  });

  it("supersedes a hung send after membership repair preserves its conversation", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    const hungSend = deferred<SendAttemptResult>();
    api.sendResults.push(hungSend.promise, {
      status: "accepted",
      response: { message: ownMessage, attachments: [], syncCursor: "12" },
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.sendMessage(CONVERSATION_ID, "Preserved across repair", []);
    await settle(() => api.sent.length === 1, "pre-repair send");

    api.bootstrapResults.push(bootstrapAt("11"));
    api.emitWorkspaceEvent(
      membershipChanged(
        "20000000-0000-4000-8000-000000000080",
        "11",
        "removed",
        SECOND_CONVERSATION_ID,
      ),
    );
    await settle(() => api.acknowledged.includes("11"), "membership repair acknowledgement");
    await settle(() => api.sent.length === 2, "post-repair send owner");
    await settle(() => runtime.state.outbox.length === 0, "post-repair send reconciliation");

    expect(api.sent[0]?.message.clientMessageId).toBe(api.sent[1]?.message.clientMessageId);
    expect(runtime.state.outbox).toEqual([]);

    hungSend.resolve({
      status: "accepted",
      response: { message: ownMessage, attachments: [], syncCursor: "12" },
    });
    await drain();

    expect(api.sent).toHaveLength(2);
    expect((await cache.load()).outbox).toEqual([]);
    expect(runtime.state.messages.filter((message) => message.id === OWN_MESSAGE_ID)).toHaveLength(
      1,
    );
  });

  it("applies a realtime event without reloading the whole decrypted cache", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    const loadsAfterStart = cache.loadCount;

    api.emitWorkspaceEvent(peerEvent);
    await settle(
      () => runtime.state.messages.some((item) => item.id === PEER_MESSAGE_ID),
      "peer message application",
    );

    expect(cache.loadCount).toBe(loadsAfterStart);
    expect((await cache.load()).messages.map((item) => item.id)).toContain(PEER_MESSAGE_ID);
  });

  it("opens a search hit in the main timeline and clears the focus on normal navigation", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    const searchHit: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000014",
      clientMessageId: "20000000-0000-4000-8000-000000000015",
      body: "Quarterly avalanche review",
      conversationSequence: "3",
    };
    api.searchResults.push({ results: [{ message: searchHit }], nextCursor: null });

    const response = await runtime.searchMessages("quarterly avalanche");
    expect(api.searchRequests).toEqual([{ query: "quarterly avalanche", limit: 25 }]);
    const firstResult = response.results[0];
    if (firstResult === undefined) throw new Error("Expected a search result");
    await runtime.openSearchResult(firstResult);

    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.focusedMessageId).toBe(searchHit.id);
    expect(runtime.state.messages).toContainEqual(searchHit);
    expect((await cache.load()).messages).toContainEqual(searchHit);

    runtime.selectConversation(CONVERSATION_ID);
    expect(runtime.state.focusedMessageId).toBeNull();
  });

  it("drops a search response released after its conversation is revoked", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const privateMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000081",
      clientMessageId: "20000000-0000-4000-8000-000000000082",
      conversationId: SECOND_CONVERSATION_ID,
      body: "Must not escape a completed membership repair",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    const delayedSearch = deferred<MessageSearchResponse>();
    api.searchResults.push(delayedSearch.promise);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const searching = runtime.searchMessages("private result");
    await settle(() => api.searchRequests.length === 1, "delayed search request");
    api.bootstrapResults.push(bootstrapAt("11"));
    api.emitWorkspaceEvent(
      membershipChanged(
        "20000000-0000-4000-8000-000000000083",
        "11",
        "removed",
        SECOND_CONVERSATION_ID,
      ),
    );
    await settle(() => api.acknowledged.includes("11"), "search membership repair");

    delayedSearch.resolve({ results: [{ message: privateMessage }], nextCursor: null });
    await expect(searching).resolves.toEqual({ results: [], nextCursor: null });
  });

  it("drops a channel-members response released after its conversation is revoked", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    const delayedMembers = deferred<ChannelMembersResponse>();
    api.channelMemberResults.push(delayedMembers.promise);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const listing = runtime.getChannelMembers(SECOND_CONVERSATION_ID);
    await settle(() => api.channelMemberRequests.length === 1, "delayed channel members request");
    api.bootstrapResults.push(bootstrapAt("11"));
    api.emitWorkspaceEvent(
      membershipChanged(
        "20000000-0000-4000-8000-000000000084",
        "11",
        "removed",
        SECOND_CONVERSATION_ID,
      ),
    );
    await settle(() => api.acknowledged.includes("11"), "members membership repair");

    delayedMembers.resolve({
      conversationId: SECOND_CONVERSATION_ID,
      access: "members",
      members: [{ user, role: "owner", joinedAt: NOW }],
      canManage: true,
    });
    await expect(listing).rejects.toThrow("This conversation is no longer available");
  });

  it("reauthorizes and opens an exact notification message in the main timeline", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.messageByIdResults.push({ message: peerMessage });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await runtime.handleNotificationAction(notificationAction, notificationContext);

    expect(api.messageByIdRequests).toEqual([PEER_MESSAGE_ID]);
    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.focusedMessageId).toBe(PEER_MESSAGE_ID);
    expect(runtime.state.selectedThreadRootId).toBeNull();
    expect(runtime.state.messages).toContainEqual(peerMessage);
    expect((await cache.load()).messages).toContainEqual(peerMessage);
    expect(runtime.state.error).toBeNull();
  });

  it("opens an authorized notification target when optional hydration fails", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(CONVERSATION_ID, "yada-yada"),
      conversation: {
        ...channel(CONVERSATION_ID, "yada-yada").conversation,
        access: "members",
      },
      participantIds: [USER_ID, PEER_ID],
      membershipRole: "member",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversations: [privateSummary], members: [user, peer] }),
    );
    api.messageByIdResults.push({ message: peerMessage });
    const reactionFailure = Promise.reject(new Error("Reaction lookup is unavailable"));
    const attachmentFailure = Promise.reject(new Error("Attachment lookup is unavailable"));
    void reactionFailure.catch(() => undefined);
    void attachmentFailure.catch(() => undefined);
    api.reactionResults.push(reactionFailure);
    api.attachmentResults.push(attachmentFailure);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    await expect(
      runtime.handleNotificationAction(notificationAction, notificationContext),
    ).resolves.toBe("opened");

    expect(api.messageByIdRequests).toEqual([PEER_MESSAGE_ID]);
    expect(api.reactionRequests).toEqual([[PEER_MESSAGE_ID]]);
    expect(api.attachmentRequests).toEqual([[PEER_MESSAGE_ID]]);
    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.focusedMessageId).toBe(PEER_MESSAGE_ID);
    expect(runtime.state.messages).toContainEqual(peerMessage);
    expect((await cache.load()).messages).toContainEqual(peerMessage);
    expect(runtime.state.error).toBeNull();
  });

  it("falls back when a cached notification target has been retracted", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);
    api.emitWorkspaceEvent(peerEvent);
    await settle(
      () => runtime.state.messages.some((message) => message.id === PEER_MESSAGE_ID),
      "cached notification target",
    );
    await settle(
      () => api.attachmentRequests.length === 1,
      "cached notification target attachment hydration",
    );
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000b8",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "12",
      conversationSequence: peerMessage.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: PEER_MESSAGE_ID, deletedAt: NOW },
    });
    await settle(() => api.acknowledged.includes("12"), "notification target retract");
    const attachmentRequestsBeforeNotification = [...api.attachmentRequests];

    await expect(
      runtime.handleNotificationAction(notificationAction, notificationContext),
    ).resolves.toBe("fallback");

    expect(api.messageByIdRequests).toEqual([]);
    expect(api.reactionRequests).toEqual([]);
    expect(api.attachmentRequests).toEqual(attachmentRequestsBeforeNotification);
    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.focusedMessageId).toBeNull();
    expect(runtime.state.error).toBe("That notification is no longer available.");
  });

  it("falls back when a source-less retract wins during exact notification hydration", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const hydration = deferred<MessageByIdResponse>();
    api.messageByIdResults.push(hydration.promise);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const opening = runtime.handleNotificationAction(notificationAction, notificationContext);
    await settle(() => api.messageByIdRequests.length === 1, "exact notification hydration");

    api.bootstrap = bootstrapAt("11");
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-0000000000f0",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: peerMessage.conversationSequence,
      entityVersion: 2,
      delivery: "at_least_once",
      payload: { messageId: PEER_MESSAGE_ID, deletedAt: NOW },
    });
    await settle(
      () => api.bootstrapRequests === 2,
      "source-less retract metadata refresh during notification hydration",
    );

    hydration.resolve({ message: peerMessage, attachments: [] });

    await expect(opening).resolves.toBe("fallback");

    expect(api.reactionRequests).toEqual([]);
    expect(api.attachmentRequests).toEqual([]);
    expect(runtime.state.focusedMessageId).toBeNull();
    expect(runtime.state.error).toBe("That notification is no longer available.");
    expect(runtime.state.messages).toEqual([]);
    expect((await cache.load()).messages).toEqual([]);
    expect((await cache.load()).retractReservations).toEqual([
      { messageId: PEER_MESSAGE_ID, deletedAt: NOW, entityVersion: 2 },
    ]);
  });

  it("opens an authorized notification target from the replica before by-ID hydration", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    api.emitWorkspaceEvent(peerEvent);
    await settle(
      () => runtime.state.messages.some((message) => message.id === PEER_MESSAGE_ID),
      "cached notification target",
    );

    await runtime.handleNotificationAction(notificationAction, notificationContext);

    expect(api.messageByIdRequests).toEqual([]);
    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.focusedMessageId).toBe(PEER_MESSAGE_ID);
    expect(runtime.state.error).toBeNull();
  });

  it("opens an exact notification reply inside its canonical thread", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.messageByIdResults.push({ message: threadReply });
    api.threadResults.push({ root: ownMessage, replies: [threadReply], nextCursor: null });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    await runtime.handleNotificationAction(
      {
        ...notificationAction,
        messageId: THREAD_REPLY_ID,
        threadRootId: OWN_MESSAGE_ID,
      },
      notificationContext,
    );

    expect(api.messageByIdRequests).toEqual([THREAD_REPLY_ID]);
    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.selectedThreadRootId).toBe(OWN_MESSAGE_ID);
    expect(runtime.state.focusedMessageId).toBeNull();
    expect(runtime.state.focusedThreadMessageId).toBe(THREAD_REPLY_ID);
    expect(runtime.state.messages).toContainEqual(ownMessage);
    expect(runtime.state.messages).toContainEqual(threadReply);
  });

  it("discards notification actions outside the current session generation and scope", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);
    const before = runtime.state;

    await runtime.handleNotificationAction(
      { ...notificationAction, sessionGeneration: notificationContext.sessionGeneration - 1 },
      notificationContext,
    );
    await runtime.handleNotificationAction(
      { ...notificationAction, userId: OTHER_USER_ID },
      notificationContext,
    );
    await runtime.handleNotificationAction(
      { ...notificationAction, workspaceId: OTHER_WORKSPACE_ID },
      notificationContext,
    );
    await runtime.handleNotificationAction(notificationAction, {
      version: 1,
      status: "inactive",
      sessionGeneration: null,
      rendererSessionGeneration: notificationContext.rendererSessionGeneration,
      userId: null,
      workspaceId: null,
    });

    expect(api.messageByIdRequests).toEqual([]);
    expect(runtime.state).toBe(before);
  });

  it("falls back only to an authorized conversation when exact hydration is unavailable", async () => {
    const secondSummary = channel(SECOND_CONVERSATION_ID, "second");
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), secondSummary],
      }),
    );
    api.messageByIdFailures = 1;
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    runtime.selectConversation(SECOND_CONVERSATION_ID);

    await runtime.handleNotificationAction(notificationAction, notificationContext);

    expect(api.messageByIdRequests).toEqual([PEER_MESSAGE_ID]);
    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.focusedMessageId).toBeNull();
    expect(runtime.state.error).toBe("That notification is no longer available.");
    expect((await cache.load()).messages).toEqual([]);

    const beforeUnauthorized = runtime.state;
    await runtime.handleNotificationAction(
      { ...notificationAction, conversationId: CREATED_CHANNEL_ID },
      notificationContext,
    );
    expect(api.messageByIdRequests).toEqual([PEER_MESSAGE_ID]);
    expect(runtime.state).toBe(beforeUnauthorized);
  });

  it("never projects an exact response whose target metadata does not match the action", async () => {
    const secondSummary = channel(SECOND_CONVERSATION_ID, "second");
    const mismatchedMessage: Message = {
      ...peerMessage,
      conversationId: SECOND_CONVERSATION_ID,
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), secondSummary],
      }),
    );
    api.messageByIdResults.push({ message: mismatchedMessage });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    runtime.selectConversation(SECOND_CONVERSATION_ID);

    await runtime.handleNotificationAction(notificationAction, notificationContext);

    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.focusedMessageId).toBeNull();
    expect(runtime.state.messages).not.toContainEqual(mismatchedMessage);
    expect((await cache.load()).messages).not.toContainEqual(mismatchedMessage);
    expect(runtime.state.error).toBe("That notification is no longer available.");
  });

  it("discards an exact hydration response after the local runtime generation changes", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const hydration = deferred<MessageByIdResponse>();
    api.messageByIdResults.push(hydration.promise);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const opening = runtime.handleNotificationAction(notificationAction, notificationContext);
    await settle(() => api.messageByIdRequests.length === 1, "exact notification hydration");
    await runtime.stop();
    api.bootstrap = otherBootstrapAt("20");
    api.cryptoStatus = {
      mode: "memory_only",
      scope: { userId: OTHER_USER_ID, workspaceId: OTHER_WORKSPACE_ID },
      reason: "credential_store_unavailable",
    };
    await runtime.start(otherSession);
    hydration.resolve({ message: peerMessage, attachments: [] });
    await opening;

    expect(runtime.state.bootstrap?.currentUser.user.id).toBe(OTHER_USER_ID);
    expect(runtime.state.bootstrap?.workspace.id).toBe(OTHER_WORKSPACE_ID);
    expect(runtime.state.selectedConversationId).toBeNull();
    expect(runtime.state.messages).toEqual([]);
    expect((await cache.load()).messages).toEqual([]);
  });

  it("does not continue an in-flight reply action into a replacement scope", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.messageByIdResults.push({ message: threadReply });
    const reactionHydration = deferred<ListMessageReactionsResponse>();
    api.reactionResults.push(reactionHydration.promise);
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    const opening = runtime.handleNotificationAction(
      {
        ...notificationAction,
        messageId: THREAD_REPLY_ID,
        threadRootId: OWN_MESSAGE_ID,
      },
      notificationContext,
    );
    await settle(() => api.reactionRequests.length === 1, "notification reaction hydration");

    api.bootstrap = otherBootstrapAt("20");
    api.cryptoStatus = {
      mode: "memory_only",
      scope: { userId: OTHER_USER_ID, workspaceId: OTHER_WORKSPACE_ID },
      reason: "credential_store_unavailable",
    };
    const replacement = runtime.start(otherSession);
    reactionHydration.resolve({ reactions: [] });

    await expect(opening).resolves.toBe("discarded");
    await replacement;
    expect(api.threadRequests).toEqual([]);
    expect(runtime.state.bootstrap?.currentUser.user.id).toBe(OTHER_USER_ID);
    expect(runtime.state.bootstrap?.workspace.id).toBe(OTHER_WORKSPACE_ID);
    expect(runtime.state.selectedThreadRootId).toBeNull();
    expect(runtime.state.focusedThreadMessageId).toBeNull();
  });

  it("orders a peer-created conversation the way a cold load would", async () => {
    const alphaId = "20000000-0000-4000-8000-000000000010";
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-00000000000e",
      type: "channel.created",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: alphaId,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { conversation: channel(alphaId, "alpha").conversation, participantIds: [] },
    });
    await settle(
      () => runtime.state.bootstrap?.conversations.length === 2,
      "peer channel application",
    );

    // "alpha" sorts before "general", so appending it renders it last in the sidebar until the next
    // full reload silently moves it.
    expect(runtime.state.bootstrap?.conversations.map((item) => item.conversation.slug)).toEqual([
      "alpha",
      "general",
    ]);
  });

  it("purges a removed member's private channel, history, and active selection", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    const privateMessage = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000012",
      conversationId: SECOND_CONVERSATION_ID,
    };
    api.histories.set(SECOND_CONVERSATION_ID, {
      messages: [privateMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    runtime.selectConversation(SECOND_CONVERSATION_ID);
    expect(runtime.state.messages).toContainEqual(privateMessage);

    api.bootstrap = bootstrapAt("11");
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000013",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: SECOND_CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: USER_ID, action: "removed" },
    });

    await settle(
      () =>
        runtime.state.selectedConversationId === CONVERSATION_ID &&
        cache.operations.includes("applyEvent:channel.membership_changed"),
      "durable membership removal",
    );
    expect(runtime.state.bootstrap?.conversations).toHaveLength(1);
    expect(runtime.state.messages).not.toContainEqual(privateMessage);
    expect((await cache.load()).messages).not.toContainEqual(privateMessage);
    // The durable purge is published before the authoritative refresh and acknowledgement.
    expect(api.acknowledged).not.toContain("11");
    await settle(() => api.acknowledged.includes("11"), "membership repair acknowledgement");
    expect(api.acknowledged).toContain("11");
  });

  it("completes two accepted removals across a realtime restart before acknowledging each", async () => {
    const thirdConversationId = "20000000-0000-4000-8000-000000000040";
    const firstPrivate = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members" as const,
      },
      participantIds: [USER_ID],
      membershipRole: "owner" as const,
    };
    const secondPrivate = {
      ...channel(thirdConversationId, "finance"),
      conversation: {
        ...channel(thirdConversationId, "finance").conversation,
        access: "members" as const,
      },
      participantIds: [USER_ID],
      membershipRole: "owner" as const,
    };
    const firstMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000041",
      clientMessageId: "20000000-0000-4000-8000-000000000042",
      conversationId: SECOND_CONVERSATION_ID,
    };
    const secondMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000043",
      clientMessageId: "20000000-0000-4000-8000-000000000044",
      conversationId: thirdConversationId,
    };
    const initial = bootstrapAt("10", {
      conversations: [channel(CONVERSATION_ID, "general"), firstPrivate, secondPrivate],
    });
    const api = new FakeDesktopApi(initial);
    api.histories.set(SECOND_CONVERSATION_ID, {
      messages: [firstMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    api.histories.set(thirdConversationId, {
      messages: [secondMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const firstRefresh = deferred<HumanWorkspaceBootstrapResponse>();
    const secondRefresh = deferred<HumanWorkspaceBootstrapResponse>();
    api.bootstrapResults.push(firstRefresh.promise, secondRefresh.promise);
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000045",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: SECOND_CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: USER_ID, action: "removed" },
    });
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000046",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: thirdConversationId,
      workspaceSequence: "12",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: USER_ID, action: "removed" },
    });

    await settle(
      () =>
        cache.operations.filter(
          (operation) => operation === "applyEvent:channel.membership_changed",
        ).length === 1,
      "first queued membership purge",
    );
    expect((await cache.load()).messages).not.toContainEqual(firstMessage);
    expect(api.acknowledged).not.toContain("11");

    firstRefresh.resolve(
      bootstrapAt("11", {
        conversations: [channel(CONVERSATION_ID, "general"), secondPrivate],
      }),
    );
    await settle(() => api.acknowledged.includes("11"), "first membership acknowledgement");
    await drain();
    expect(
      cache.operations.filter((operation) => operation === "applyEvent:channel.membership_changed"),
    ).toHaveLength(2);
    expect(api.startedCursors).toHaveLength(2);
    expect(api.acknowledged).toContain("11");
    expect(api.acknowledged).not.toContain("12");
    expect((await cache.load()).messages).not.toContainEqual(secondMessage);

    secondRefresh.resolve(bootstrapAt("12"));
    await settle(() => api.acknowledged.includes("12"), "second membership acknowledgement");

    const durable = await cache.load();
    expect(durable.bootstrap?.conversations.map((summary) => summary.conversation.id)).toEqual([
      CONVERSATION_ID,
    ]);
    expect(durable.messages).toEqual([]);
    expect(api.acknowledged.filter((cursor) => cursor === "11" || cursor === "12")).toEqual([
      "11",
      "12",
    ]);
  });

  it("retries an in-flight repair snapshot when a second removal invalidates it", async () => {
    const thirdConversationId = "20000000-0000-4000-8000-000000000052";
    const firstPrivate = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members" as const,
      },
      participantIds: [USER_ID],
      membershipRole: "owner" as const,
    };
    const secondPrivate = {
      ...channel(thirdConversationId, "finance"),
      conversation: {
        ...channel(thirdConversationId, "finance").conversation,
        access: "members" as const,
      },
      participantIds: [USER_ID],
      membershipRole: "owner" as const,
    };
    const firstMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000053",
      clientMessageId: "20000000-0000-4000-8000-000000000054",
      conversationId: SECOND_CONVERSATION_ID,
    };
    const secondMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000055",
      clientMessageId: "20000000-0000-4000-8000-000000000056",
      conversationId: thirdConversationId,
    };
    const initial = bootstrapAt("10", {
      conversations: [channel(CONVERSATION_ID, "general"), firstPrivate, secondPrivate],
    });
    const api = new FakeDesktopApi(initial);
    api.histories.set(SECOND_CONVERSATION_ID, {
      messages: [firstMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    api.histories.set(thirdConversationId, {
      messages: [secondMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    const cache = new FakeWorkspaceCache();
    const queuedSecondRemovalId = "20000000-0000-4000-8000-000000000059";
    await cache.replaceSnapshot(initial, []);
    await cache.enqueue(
      queuedOperation(queuedSecondRemovalId, "Queued before second removal", thirdConversationId),
    );
    await cache.clearServerStatePreservingOutbox();
    await cache.updateOutbox(queuedSecondRemovalId, {
      status: "permanent_failure",
      attemptCount: 1,
      nextAttemptAt: null,
      failureReason: "offline",
    });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    expect(runtime.state.outbox.map((item) => item.operation.conversationId)).toContain(
      thirdConversationId,
    );

    const staleFirstRefresh = deferred<HumanWorkspaceBootstrapResponse>();
    api.bootstrapResults.push(
      staleFirstRefresh.promise,
      bootstrapAt("12", { conversations: [channel(CONVERSATION_ID, "general")] }),
    );
    api.emitWorkspaceEvent(
      membershipChanged(
        "20000000-0000-4000-8000-000000000057",
        "11",
        "removed",
        SECOND_CONVERSATION_ID,
      ),
    );
    // Both events are accepted before the first repair can retire the prepared scope. The first
    // marker owns durable repair while the second marker invalidates its snapshot.
    api.emitWorkspaceEvent(
      membershipChanged(
        "20000000-0000-4000-8000-000000000058",
        "12",
        "removed",
        thirdConversationId,
      ),
    );
    expect(runtime.state.messages).not.toContainEqual(secondMessage);
    expect((await cache.load()).messages).toContainEqual(secondMessage);
    expect(runtime.state.outbox).toEqual([]);
    expect((await cache.load()).outbox.map((item) => item.operation.conversationId)).toContain(
      thirdConversationId,
    );

    staleFirstRefresh.resolve(
      bootstrapAt("11", {
        conversations: [channel(CONVERSATION_ID, "general"), secondPrivate],
      }),
    );
    await settle(() => api.acknowledged.includes("12"), "both membership acknowledgements");
    await drain();

    const durable = await cache.load();
    expect(api.bootstrapRequests).toBe(3);
    expect(api.acknowledged.filter((cursor) => cursor === "11" || cursor === "12")).toEqual([
      "11",
      "12",
    ]);
    expect(api.startedCursors).toEqual(["10", "11", "12"]);
    expect(durable.repairMarker).toBeNull();
    expect(durable.bootstrap?.conversations.map((summary) => summary.conversation.id)).toEqual([
      CONVERSATION_ID,
    ]);
    expect(durable.messages).toEqual([]);
    expect(durable.outbox).toEqual([]);
    expect(runtime.state.messages).toEqual([]);
    expect(runtime.state.outbox).toEqual([]);
    expect(api.sent).toEqual([]);
    expect(runtime.state.error).toBeNull();
  });

  it("drops an older-history response released after membership repair is acknowledged", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const currentPrivateMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000076",
      clientMessageId: "20000000-0000-4000-8000-000000000077",
      conversationId: SECOND_CONVERSATION_ID,
    };
    const olderPrivateMessage: Message = {
      ...currentPrivateMessage,
      id: "20000000-0000-4000-8000-000000000078",
      clientMessageId: "20000000-0000-4000-8000-000000000079",
      conversationSequence: "0",
      body: "Must stay purged after a delayed history response",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    api.histories.set(SECOND_CONVERSATION_ID, {
      messages: [currentPrivateMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: "older-private-history",
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const delayedHistory = deferred<MessageHistoryResponse>();
    api.historyResults.set(SECOND_CONVERSATION_ID, [delayedHistory.promise]);
    const requestsBeforeLoad = api.historyRequests.length;
    const loading = runtime.loadOlder(SECOND_CONVERSATION_ID);
    await settle(
      () => api.historyRequests.length === requestsBeforeLoad + 1,
      "delayed private history request",
    );

    api.bootstrapResults.push(bootstrapAt("11"));
    api.emitWorkspaceEvent(
      membershipChanged(
        "20000000-0000-4000-8000-00000000007a",
        "11",
        "removed",
        SECOND_CONVERSATION_ID,
      ),
    );
    await settle(
      () => api.acknowledged.includes("11"),
      "history membership repair acknowledgement",
    );

    delayedHistory.resolve({
      messages: [olderPrivateMessage],
      threadSummaries: [],
      threadsSupported: true,
      attachments: [],
      nextCursor: null,
    });
    await loading;
    await drain();

    expect(
      runtime.state.messages.filter((message) => message.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
    expect(
      (await cache.load()).messages.filter(
        (message) => message.conversationId === SECOND_CONVERSATION_ID,
      ),
    ).toEqual([]);
  });

  it("drops a task-list response released after membership repair is acknowledged", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const privateTask: Task = {
      ...task,
      id: "20000000-0000-4000-8000-00000000007b",
      conversationId: SECOND_CONVERSATION_ID,
      sourceMessageId: null,
      title: "Must stay purged after a delayed task response",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    const delayedTasks = deferred<TaskListResponse>();
    api.conversationTaskResults.push(delayedTasks.promise);
    const requestsBeforeLoad = api.conversationTaskRequests.length;
    const loading = runtime.loadConversationTasks(SECOND_CONVERSATION_ID);
    await settle(
      () => api.conversationTaskRequests.length === requestsBeforeLoad + 1,
      "delayed private task request",
    );

    api.bootstrapResults.push(bootstrapAt("11"));
    api.emitWorkspaceEvent(
      membershipChanged(
        "20000000-0000-4000-8000-00000000007c",
        "11",
        "removed",
        SECOND_CONVERSATION_ID,
      ),
    );
    await settle(() => api.acknowledged.includes("11"), "task membership repair acknowledgement");

    delayedTasks.resolve({ tasks: [privateTask], nextCursor: null, hasMore: false });
    await loading;
    await drain();

    expect(
      runtime.state.tasks.filter((item) => item.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
    expect(
      (await cache.load()).tasks.filter((item) => item.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
  });

  it("rejects an ordinary frame queued by the realtime session a repair superseded", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    const refresh = deferred<HumanWorkspaceBootstrapResponse>();
    api.bootstrapResults.push(refresh.promise);
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000047",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: USER_ID, action: "updated" },
    });
    const staleMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000048",
      clientMessageId: "20000000-0000-4000-8000-000000000049",
      conversationSequence: "2",
    };
    api.emitWorkspaceEvent({
      ...peerEvent,
      id: "20000000-0000-4000-8000-00000000004a",
      workspaceSequence: "12",
      conversationSequence: "2",
      payload: { message: staleMessage, mentionedUserIds: [] },
    });

    await settle(
      () => cache.operations.includes("applyEvent:channel.membership_changed"),
      "membership repair before stale frame",
    );
    refresh.resolve(bootstrapAt("11"));
    await settle(() => api.acknowledged.includes("11"), "membership repair restart");
    await drain();

    expect(cache.operations).not.toContain("applyEvent:message.created");
    expect((await cache.load()).messages).not.toContainEqual(staleMessage);
    expect(api.acknowledged).not.toContain("12");
  });

  it("keeps an offline self-removal durable and blocks later events and queued sends", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const privateMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-00000000002a",
      clientMessageId: "20000000-0000-4000-8000-00000000002b",
      conversationId: SECOND_CONVERSATION_ID,
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    api.histories.set(SECOND_CONVERSATION_ID, {
      messages: [privateMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    const cache = new FakeWorkspaceCache();
    const queuedId = "20000000-0000-4000-8000-00000000002c";
    await cache.enqueue(queuedOperation(queuedId, "Private queued send", SECOND_CONVERSATION_ID));
    await cache.updateOutbox(queuedId, {
      status: "permanent_failure",
      attemptCount: 1,
      nextAttemptAt: null,
      failureReason: "offline",
    });
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    api.bootstrap = bootstrapAt("11");
    api.bootstrapFailures = 1;
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-00000000002d",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: SECOND_CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: USER_ID, action: "removed" },
    });
    await settle(
      () => cache.operations.includes("stageMembershipRepair"),
      "durable membership marker",
    );
    await drain();

    const purged = await cache.load();
    expect(
      purged.bootstrap?.conversations.some(
        (summary) => summary.conversation.id === SECOND_CONVERSATION_ID,
      ),
    ).toBe(false);
    expect(
      purged.messages.filter((item) => item.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
    expect(purged.outbox).toEqual([]);
    expect(purged.repairMarker?.conversationId).toBe(SECOND_CONVERSATION_ID);
    expect(api.acknowledged).not.toContain("11");
    expect(api.sent).toEqual([]);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-00000000002e",
      type: "reaction.added",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: SECOND_CONVERSATION_ID,
      workspaceSequence: "12",
      conversationSequence: "1",
      entityVersion: 1,
      delivery: "at_least_once",
      payload: {
        reaction: {
          id: "20000000-0000-4000-8000-00000000002f",
          messageId: privateMessage.id,
          userId: PEER_ID,
          emoji: "🎉",
          createdAt: NOW,
        },
      },
    });
    await drain();
    expect((await cache.load()).reactions).toEqual([]);
    expect(api.acknowledged).not.toContain("12");
  });

  it("does not reinsert a removed conversation when an in-flight send resolves", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    const accepted = deferred<SendAttemptResult>();
    const repair = deferred<HumanWorkspaceBootstrapResponse>();
    api.sendResults.push(accepted.promise);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    await runtime.sendMessage(SECOND_CONVERSATION_ID, "In flight before removal", []);
    await settle(() => api.sent.length === 1, "private send in flight");
    const sent = api.sent[0];
    if (sent === undefined) throw new Error("Expected an in-flight send");

    api.bootstrapResults.push(repair.promise);
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000033",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: SECOND_CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: USER_ID, action: "removed" },
    });
    await settle(
      () => cache.operations.includes("stageMembershipRepair"),
      "in-flight send membership barrier",
    );

    accepted.resolve({
      status: "accepted",
      response: {
        message: {
          ...ownMessage,
          id: "20000000-0000-4000-8000-000000000034",
          clientMessageId: sent.message.clientMessageId,
          conversationId: SECOND_CONVERSATION_ID,
        },
        attachments: [],
        syncCursor: "12",
      },
    });
    await drain();

    const blocked = await cache.load();
    expect(
      blocked.messages.filter((item) => item.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
    expect(blocked.outbox).toEqual([]);
    expect(
      runtime.state.messages.filter((item) => item.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
    expect(api.acknowledged).not.toContain("11");

    repair.resolve(bootstrapAt("12"));
    await settle(() => api.acknowledged.includes("12"), "in-flight send membership repair");
  });

  it("drops an in-flight send response that resolves after membership repair", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    const accepted = deferred<SendAttemptResult>();
    api.sendResults.push(accepted.promise);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    await runtime.sendMessage(SECOND_CONVERSATION_ID, "In flight before removal", []);
    await settle(() => api.sent.length === 1, "private send in flight");
    const sent = api.sent[0];
    if (sent === undefined) throw new Error("Expected an in-flight send");

    api.bootstrapResults.push(bootstrapAt("11"));
    api.emitWorkspaceEvent(
      membershipChanged(
        "20000000-0000-4000-8000-00000000005a",
        "11",
        "removed",
        SECOND_CONVERSATION_ID,
      ),
    );
    await settle(() => api.acknowledged.includes("11"), "membership repair before send response");

    accepted.resolve({
      status: "accepted",
      response: {
        message: {
          ...ownMessage,
          id: "20000000-0000-4000-8000-00000000005b",
          clientMessageId: sent.message.clientMessageId,
          conversationId: SECOND_CONVERSATION_ID,
        },
        attachments: [],
        syncCursor: "12",
      },
    });
    await drain();

    const durable = await cache.load();
    expect(
      durable.messages.filter((item) => item.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
    expect(durable.outbox).toEqual([]);
    expect(
      runtime.state.messages.filter((item) => item.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
    expect(runtime.state.outbox).toEqual([]);
    expect(runtime.state.error).toBeNull();
  });

  it("drops an accepted send when membership repair wins cache reconciliation", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    const accepted = deferred<SendAttemptResult>();
    api.sendResults.push(accepted.promise);
    const cache = new FakeWorkspaceCache();
    const cacheReconciliation = deferred<void>();
    cache.acknowledgedMessageBarriers.push(cacheReconciliation.promise);
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    await runtime.sendMessage(SECOND_CONVERSATION_ID, "In flight before removal", []);
    await settle(() => api.sent.length === 1, "private send in flight");
    const sent = api.sent[0];
    if (sent === undefined) throw new Error("Expected an in-flight send");

    accepted.resolve({
      status: "accepted",
      response: {
        message: {
          ...ownMessage,
          id: "20000000-0000-4000-8000-00000000005c",
          clientMessageId: sent.message.clientMessageId,
          conversationId: SECOND_CONVERSATION_ID,
        },
        attachments: [],
        syncCursor: "12",
      },
    });
    await settle(
      () => cache.acknowledgedMessageAttempts === 1,
      "accepted send cache reconciliation",
    );

    api.bootstrapResults.push(bootstrapAt("11"));
    api.emitWorkspaceEvent(
      membershipChanged(
        "20000000-0000-4000-8000-00000000005d",
        "11",
        "removed",
        SECOND_CONVERSATION_ID,
      ),
    );
    await settle(() => api.acknowledged.includes("11"), "repair during cache reconciliation");
    cacheReconciliation.resolve();
    await drain();

    const durable = await cache.load();
    expect(
      durable.messages.filter((item) => item.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
    expect(durable.outbox).toEqual([]);
    expect(
      runtime.state.messages.filter((item) => item.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
    expect(runtime.state.outbox).toEqual([]);
    expect(runtime.state.error).toBeNull();
  });

  it("publishes a durable purge before a hung old-run shutdown can block a fresh run", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const initial = bootstrapAt("10", {
      conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
    });
    const privateMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000030",
      clientMessageId: "20000000-0000-4000-8000-000000000031",
      conversationId: SECOND_CONVERSATION_ID,
    };
    const oldApi = new FakeDesktopApi(initial);
    oldApi.histories.set(SECOND_CONVERSATION_ID, {
      messages: [privateMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    const cache = new FakeWorkspaceCache();
    const oldRuntime = runtimeWith(oldApi, cache);
    await oldRuntime.start(session);

    const hungShutdown = deferred<void>();
    oldApi.stopResults.push(hungShutdown.promise);
    oldApi.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000032",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: SECOND_CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: USER_ID, action: "removed" },
    });
    await settle(
      () => cache.operations.includes("stageMembershipRepair"),
      "purge while realtime shutdown is hung",
    );

    const durable = await cache.load();
    expect(durable.repairMarker?.conversationId).toBe(SECOND_CONVERSATION_ID);
    expect(
      durable.bootstrap?.conversations.some(
        (summary) => summary.conversation.id === SECOND_CONVERSATION_ID,
      ),
    ).toBe(false);
    expect(durable.messages).toEqual([]);
    expect(oldApi.acknowledged).not.toContain("11");

    // Even a stale pre-removal snapshot cannot reopen the conversation while the old run waits.
    const freshApi = new FakeDesktopApi(initial);
    const freshRuntime = runtimeWith(freshApi, cache);
    await freshRuntime.start(session);
    expect(
      freshRuntime.state.bootstrap?.conversations.some(
        (summary) => summary.conversation.id === SECOND_CONVERSATION_ID,
      ),
    ).toBe(false);
    expect(freshRuntime.state.messages).toEqual([]);

    hungShutdown.resolve();
  });

  it("does not let a snapshot started before the barrier repopulate removed data", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const initial = bootstrapAt("10", {
      conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
    });
    const privateMessage: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000035",
      clientMessageId: "20000000-0000-4000-8000-000000000036",
      conversationId: SECOND_CONVERSATION_ID,
    };
    const staleSnapshot = deferred<HumanWorkspaceBootstrapResponse>();
    const api = new FakeDesktopApi(initial);
    api.bootstrapResults.push(staleSnapshot.promise, bootstrapAt("12"));
    api.histories.set(SECOND_CONVERSATION_ID, {
      messages: [privateMessage],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    });
    const cache = new FakeWorkspaceCache();
    await cache.replaceSnapshot(initial, [privateMessage]);
    const runtime = runtimeWith(api, cache);

    const starting = runtime.start(session);
    await settle(() => api.bootstrapRequests === 1, "pre-barrier snapshot request");
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000037",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: SECOND_CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: USER_ID, action: "removed" },
    });
    await settle(() => api.bootstrapRequests === 2, "authoritative membership repair");
    await drain();

    staleSnapshot.resolve(initial);
    await starting;

    const durable = await cache.load();
    expect(
      durable.bootstrap?.conversations.some(
        (summary) => summary.conversation.id === SECOND_CONVERSATION_ID,
      ),
    ).toBe(false);
    expect(
      durable.messages.filter((item) => item.conversationId === SECOND_CONVERSATION_ID),
    ).toEqual([]);
    expect(runtime.state.messages).toEqual([]);
  });

  it("orders a newly delivered member the way a cold load would", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const alice: User = {
      id: "20000000-0000-4000-8000-000000000011",
      kind: "human",
      username: "alice",
      displayName: "Alice",
      avatarUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    // The refetched directory arrives in the server's own order; the runtime still sorts it, so
    // realtime application and a cold load agree.
    api.members = [user, alice];
    api.emitWorkspaceEvent(memberUpdated(MEMBER_EVENT_ID, "11", alice));
    await settle(() => runtime.state.bootstrap?.members.length === 2, "member directory refetch");

    expect(runtime.state.bootstrap?.members.map((item) => item.displayName)).toEqual([
      "Alice",
      "Morgan",
    ]);
  });

  it("drops a disabled member from the directory when member.updated arrives over realtime", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, agent] }));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID, AGENT_ID]);

    // The disable event carries the agent's own `User`, which has no field that can say "removed".
    // Upserting it re-asserts the agent; only the server's active-only directory can drop it.
    api.members = [user];
    api.emitWorkspaceEvent(memberUpdated(MEMBER_EVENT_ID, "11", agent));
    await settle(() => api.memberRequests === 1, "member directory refetch");
    await settle(() => runtime.state.bootstrap?.members.length === 1, "disabled member removal");

    expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
    // The mention picker and the DM sidebar both read this list, so the agent stops being a
    // resolvable target without the client re-bootstrapping.
    expect((await cache.load()).bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
    expect(api.acknowledged).toContain("11");
    expect(api.bootstrapRequests).toBe(1);
  });

  it("refreshes the directory from an offline backfill before reloading the cache", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, agent] }));
    api.syncResults.push({
      status: "accepted",
      response: {
        events: [memberUpdated(MEMBER_EVENT_ID, "11", agent)],
        nextCursor: "11",
        highWaterCursor: "11",
        hasMore: false,
      },
    });
    api.members = [user];
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);

    await runtime.start(session);

    expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
    // The backfill loop bypasses #applyWorkspaceEvent, so the refetch has to be drained by the
    // flush itself — and before the reload, or the reload would republish the stale cached list.
    expect(cache.operations.slice(cache.operations.indexOf("applyEvent:member.updated"))).toEqual([
      "applyEvent:member.updated",
      "replaceMembers",
      "load",
      "load",
    ]);
  });

  it("coalesces a backfilled batch of member.updated events into one directory read", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, agent] }));
    api.syncResults.push({
      status: "accepted",
      response: {
        events: [
          memberUpdated(MEMBER_EVENT_ID, "11", agent),
          memberUpdated(SECOND_MEMBER_EVENT_ID, "12", agent),
          memberUpdated(THIRD_MEMBER_EVENT_ID, "13", agent),
        ],
        nextCursor: "13",
        highWaterCursor: "13",
        hasMore: false,
      },
    });
    api.members = [user];
    const runtime = runtimeWith(api, new FakeWorkspaceCache());

    await runtime.start(session);

    expect(api.memberRequests).toBe(1);
    expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
  });

  it("retries a failed directory read on a healthy socket, with no sync pass to lean on", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, agent] }));
      // Deliberately no queued sync result: nothing arms a sync retry, so `#repairAndFlush` is
      // never re-entered. On a connected socket that is the normal state, and it used to mean a
      // single failed read left the disabled member resolvable until the app restarted.
      api.memberFailures = 1;
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);
      const syncsAfterStart = api.syncedFrom.length;

      api.members = [user];
      api.emitWorkspaceEvent(memberUpdated(MEMBER_EVENT_ID, "11", agent));
      await settle(() => api.memberRequests === 1, "failed member directory read");
      expect(runtime.state.stale).toBe(true);
      expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID, AGENT_ID]);

      // `retryDelay(1)` is bounded above by 2s.
      await vi.advanceTimersByTimeAsync(2_000);
      await settle(() => api.memberRequests === 2, "retried member directory read");

      expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
      expect(runtime.state.stale).toBe(false);
      // The recovery must come from the directory retry itself, not from a sync pass.
      expect(api.syncedFrom.length).toBe(syncsAfterStart);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps stale state while an independent sync recovery is still pending", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, agent] }));
      const syncRecovery = deferred<SyncAttemptResult>();
      // The first attempt arms a retry; the retry then remains in flight while the independent
      // member-directory retry succeeds.
      api.syncResults.push({ status: "retryable", reason: "server", retryAfterMs: 2_000 });
      api.syncResults.push(syncRecovery.promise);
      api.memberFailures = 1;
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);

      api.members = [user];
      api.emitWorkspaceEvent(memberUpdated(MEMBER_EVENT_ID, "11", agent));
      await settle(() => api.memberRequests === 1, "failed member directory read");
      expect(runtime.state.stale).toBe(true);
      expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID, AGENT_ID]);

      await vi.advanceTimersByTimeAsync(2_000);
      await settle(() => api.memberRequests === 2, "retried member directory read");
      await settle(() => api.syncedFrom.length === 2, "in-flight sync recovery");
      expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
      expect(runtime.state.stale).toBe(true);

      syncRecovery.resolve({
        status: "accepted",
        response: {
          events: [],
          nextCursor: "11",
          highWaterCursor: "11",
          hasMore: false,
        },
      });
      await settle(() => !runtime.state.stale, "completed sync recovery");
      expect(runtime.state.stale).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps stale state while an independent resync recovery is still pending", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, agent] }));
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);

      api.bootstrap = bootstrapAt("40", { members: [user] });
      api.bootstrapFailures = 2;
      api.memberFailures = 1;

      // Queue the resync first so its first retry also fails before the member retry recovers.
      api.emitWorkspaceEvent(resyncRequired);
      api.emitWorkspaceEvent(memberUpdated(MEMBER_EVENT_ID, "11", agent));
      await settle(() => api.bootstrapRequests === 2, "failed resync download");
      await settle(() => api.memberRequests === 1, "failed member directory read");

      await vi.advanceTimersByTimeAsync(1_000);
      await settle(() => api.bootstrapRequests === 3, "failed resync retry");
      await settle(() => api.memberRequests === 2, "retried member directory read");
      expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
      expect(runtime.state.stale).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      await settle(() => api.startedCursors.length === 2, "completed resync recovery");
      expect(runtime.state.stale).toBe(false);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("discards a directory read that a newer read already superseded", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, agent] }));
      api.syncResults.push({ status: "retryable", reason: "server", retryAfterMs: 2_000 });
      const slow = deferred<ListMembersResponse>();
      api.memberResults.push(slow.promise, { members: [user] });
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);

      // The realtime read stalls, so the sync retry's drain overtakes it with the newer answer.
      api.emitWorkspaceEvent(memberUpdated(MEMBER_EVENT_ID, "11", agent));
      await settle(() => api.memberRequests === 1, "stalled member directory read");
      await vi.advanceTimersByTimeAsync(2_000);
      await settle(() => api.memberRequests === 2, "overtaking member directory read");
      expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);

      slow.resolve({ members: [user, agent] });
      await drain();
      expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes durable member replacements when a newer refetch overtakes a stalled write", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, agent] }));
      api.syncResults.push({ status: "retryable", reason: "server", retryAfterMs: 2_000 });
      api.memberResults.push({ members: [user, agent] }, { members: [user] });
      const stalledWrite = deferred<void>();
      const cache = new FakeWorkspaceCache();
      cache.memberReplaceBarriers.push(stalledWrite.promise);
      const runtime = runtimeWith(api, cache);
      await runtime.start(session);

      // The older response reaches the cache first but cannot finish its replacement. The sync
      // retry then fetches the newer directory while that durable write is still stalled.
      api.emitWorkspaceEvent(memberUpdated(MEMBER_EVENT_ID, "11", agent));
      await settle(() => api.memberRequests === 1, "first member directory read");
      await settle(
        () => cache.operations.filter((operation) => operation === "replaceMembers").length === 1,
        "stalled member replacement",
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await settle(() => api.memberRequests === 2, "overtaking member directory read");

      stalledWrite.resolve();
      await settle(
        () => cache.operations.filter((operation) => operation === "replaceMembers").length === 2,
        "serialized member replacements",
      );
      await settle(() => runtime.state.bootstrap?.members.length === 1, "fresh member projection");

      expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
      expect((await cache.load()).bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stopped session's stalled member write block the current session", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, agent] }));
    api.memberResults.push({ members: [user, agent] });
    const stalledWrite = deferred<void>();
    const cache = new FakeWorkspaceCache();
    cache.memberReplaceBarriers.push(stalledWrite.promise);
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    api.emitWorkspaceEvent(memberUpdated(MEMBER_EVENT_ID, "11", agent));
    await settle(
      () => cache.operations.filter((operation) => operation === "replaceMembers").length === 1,
      "old session member replacement",
    );
    await runtime.stop();

    await runtime.start(session);
    api.members = [user];
    api.emitWorkspaceEvent(memberUpdated(SECOND_MEMBER_EVENT_ID, "12", agent));
    await settle(() => api.memberRequests === 2, "current session member directory read");
    await settle(
      () => runtime.state.bootstrap?.members.length === 1,
      "current session member replacement",
    );
    stalledWrite.resolve();
    await drain();

    expect(runtime.state.bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
    expect((await cache.load()).bootstrap?.members.map((item) => item.id)).toEqual([USER_ID]);
  });

  it("ignores a directory read that lands after the runtime stopped", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10", { members: [user, agent] }));
    const slow = deferred<ListMembersResponse>();
    api.memberResults.push(slow.promise);
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    api.emitWorkspaceEvent(memberUpdated(MEMBER_EVENT_ID, "11", agent));
    await settle(() => api.memberRequests === 1, "stalled member directory read");
    await runtime.stop();
    slow.resolve({ members: [user] });
    await drain();

    expect(runtime.state.bootstrap).toBeNull();
  });

  it("pages conversations that the bootstrap response could not carry", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversationsNextCursor: NEXT_PAGE_CURSOR, conversationsHasMore: true }),
    );
    api.conversationPages.set(NEXT_PAGE_CURSOR, {
      conversations: [channel(SECOND_CONVERSATION_ID, "second")],
      nextCursor: null,
      hasMore: false,
    });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    expect(api.listedAfter).toEqual([NEXT_PAGE_CURSOR]);
    expect(runtime.state.bootstrap?.conversations.map((item) => item.conversation.id)).toEqual([
      CONVERSATION_ID,
      SECOND_CONVERSATION_ID,
    ]);
  });

  it.each([
    {
      label: "a bootstrap that claims more without a cursor",
      bootstrap: bootstrapAt("10", {
        conversationsNextCursor: null,
        conversationsHasMore: true,
      }),
      page: null,
    },
    {
      label: "a bootstrap that supplies a terminal cursor",
      bootstrap: bootstrapAt("10", {
        conversationsNextCursor: NEXT_PAGE_CURSOR,
        conversationsHasMore: false,
      }),
      page: null,
    },
    {
      label: "a page that claims more without a cursor",
      bootstrap: bootstrapAt("10", {
        conversationsNextCursor: NEXT_PAGE_CURSOR,
        conversationsHasMore: true,
      }),
      page: {
        conversations: [channel(SECOND_CONVERSATION_ID, "second")],
        nextCursor: null,
        hasMore: true,
      },
    },
    {
      label: "a page that supplies a terminal cursor",
      bootstrap: bootstrapAt("10", {
        conversationsNextCursor: NEXT_PAGE_CURSOR,
        conversationsHasMore: true,
      }),
      page: {
        conversations: [channel(SECOND_CONVERSATION_ID, "second")],
        nextCursor: "terminal-cursor",
        hasMore: false,
      },
    },
  ])("rejects $label before replacing the snapshot", async ({ bootstrap, page }) => {
    const api = new FakeDesktopApi(bootstrap);
    if (page !== null) api.conversationPages.set(NEXT_PAGE_CURSOR, page);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.bootstrap).toBeNull();
    expect(runtime.state.error).toBe(
      "The workspace conversation catalog had inconsistent pagination",
    );
    expect(api.startedCursors).toEqual([]);
  });

  it("rejects an empty advancing conversation page instead of accepting a partial catalog", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversationsNextCursor: NEXT_PAGE_CURSOR, conversationsHasMore: true }),
    );
    api.conversationPages.set(NEXT_PAGE_CURSOR, {
      conversations: [],
      nextCursor: "page-2",
      hasMore: true,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    expect(api.listedAfter).toEqual([NEXT_PAGE_CURSOR]);
    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.bootstrap).toBeNull();
    expect(runtime.state.error).toBe("The workspace conversation catalog did not make progress");
  });

  it("rejects a nonadvancing conversation cursor instead of accepting a partial catalog", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversationsNextCursor: NEXT_PAGE_CURSOR, conversationsHasMore: true }),
    );
    api.conversationPages.set(NEXT_PAGE_CURSOR, {
      conversations: [channel(SECOND_CONVERSATION_ID, "second")],
      nextCursor: NEXT_PAGE_CURSOR,
      hasMore: true,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    expect(api.listedAfter).toEqual([NEXT_PAGE_CURSOR]);
    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe(
      "The workspace conversation catalog did not advance its cursor",
    );
  });

  it("rejects a conversation cursor cycle without repeating requests", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversationsNextCursor: NEXT_PAGE_CURSOR, conversationsHasMore: true }),
    );
    api.conversationPages.set(NEXT_PAGE_CURSOR, {
      conversations: [channel(SECOND_CONVERSATION_ID, "second")],
      nextCursor: "page-2",
      hasMore: true,
    });
    api.conversationPages.set("page-2", {
      conversations: [catalogConversation(1)],
      nextCursor: NEXT_PAGE_CURSOR,
      hasMore: true,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    expect(api.listedAfter).toEqual([NEXT_PAGE_CURSOR, "page-2"]);
    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe(
      "The workspace conversation catalog did not advance its cursor",
    );
  });

  it("rejects duplicate conversation IDs across catalog pages", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversationsNextCursor: NEXT_PAGE_CURSOR, conversationsHasMore: true }),
    );
    api.conversationPages.set(NEXT_PAGE_CURSOR, {
      conversations: [channel(CONVERSATION_ID, "duplicate")],
      nextCursor: null,
      hasMore: false,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe("The workspace conversation catalog repeated a conversation");
  });

  it("rejects a conversation summary from another workspace", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversationsNextCursor: NEXT_PAGE_CURSOR, conversationsHasMore: true }),
    );
    api.conversationPages.set(NEXT_PAGE_CURSOR, {
      conversations: [
        {
          ...channel(SECOND_CONVERSATION_ID, "second"),
          conversation: {
            ...channel(SECOND_CONVERSATION_ID, "second").conversation,
            workspaceId: OTHER_WORKSPACE_ID,
          },
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe("The workspace conversation catalog crossed workspace scope");
  });

  it("accepts a complete catalog at the replica's 5,000-conversation capacity", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversationsNextCursor: "page-1", conversationsHasMore: true }),
    );
    addConversationCatalogPages(api, 4_999);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    expect(api.listedAfter).toHaveLength(50);
    expect(runtime.state.bootstrap?.conversations).toHaveLength(5_000);
    expect(cache.operations).toContain("replaceSnapshot");
    expect(runtime.state.error).toBeNull();
  });

  it("rejects a catalog above the replica's 5,000-conversation capacity", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversationsNextCursor: "page-1", conversationsHasMore: true }),
    );
    addConversationCatalogPages(api, 5_000);
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    expect(api.listedAfter).toHaveLength(50);
    expect(cache.operations).not.toContain("replaceSnapshot");
    expect(runtime.state.error).toBe("The workspace conversation catalog exceeded local capacity");
  });

  it("keeps a malformed membership-removal catalog durably purged and retry-blocking", async () => {
    vi.useFakeTimers();
    try {
      const privateSummary: ConversationSummary = {
        ...channel(SECOND_CONVERSATION_ID, "leadership"),
        conversation: {
          ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
          access: "members",
        },
        participantIds: [USER_ID],
        membershipRole: "owner",
      };
      const privateMessage: Message = {
        ...peerMessage,
        id: "20000000-0000-4000-8000-00000000002c",
        conversationId: SECOND_CONVERSATION_ID,
      };
      const api = new FakeDesktopApi(
        bootstrapAt("10", {
          conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
        }),
      );
      api.histories.set(SECOND_CONVERSATION_ID, {
        messages: [privateMessage],
        threadSummaries: [],
        threadsSupported: true,
        nextCursor: null,
      });
      const cache = new FakeWorkspaceCache();
      const runtime = runtimeWith(api, cache);
      await runtime.start(session);
      const replacementsBeforeRemoval = cache.operations.filter(
        (operation) => operation === "replaceSnapshot",
      ).length;

      api.bootstrap = bootstrapAt("11", {
        conversationsNextCursor: NEXT_PAGE_CURSOR,
        conversationsHasMore: true,
      });
      api.conversationPages.set(NEXT_PAGE_CURSOR, {
        conversations: [],
        nextCursor: "page-2",
        hasMore: true,
      });
      api.emitWorkspaceEvent({
        version: 1,
        id: "20000000-0000-4000-8000-00000000002d",
        type: "channel.membership_changed",
        occurredAt: NOW,
        workspaceId: WORKSPACE_ID,
        conversationId: SECOND_CONVERSATION_ID,
        workspaceSequence: "11",
        conversationSequence: null,
        entityVersion: 1,
        delivery: "at_least_once",
        payload: { memberId: USER_ID, action: "removed" },
      });
      api.emitWorkspaceEvent({
        ...reactionAddedEvent,
        id: "20000000-0000-4000-8000-00000000002e",
        workspaceSequence: "12",
      });

      await settle(() => api.stopRequests === 1, "malformed membership repair block");
      await drain();

      expect(cache.operations.filter((operation) => operation === "replaceSnapshot")).toHaveLength(
        replacementsBeforeRemoval,
      );
      expect(cache.cursor).toBe("11");
      expect(api.acknowledged).not.toContain("11");
      expect(api.acknowledged).not.toContain("12");
      expect(api.startedCursors).toEqual(["10"]);
      expect(
        runtime.state.bootstrap?.conversations.map((item) => item.conversation.id),
      ).not.toContain(SECOND_CONVERSATION_ID);
      expect(runtime.state.messages).not.toContainEqual(privateMessage);
      const blocked = await cache.load();
      expect(blocked.bootstrap?.conversations.map((item) => item.conversation.id)).not.toContain(
        SECOND_CONVERSATION_ID,
      );
      expect(blocked.messages).not.toContainEqual(privateMessage);
      expect(blocked.repairMarker).toEqual({
        kind: "membership",
        eventId: "20000000-0000-4000-8000-00000000002d",
        workspaceSequence: "11",
        conversationId: SECOND_CONVERSATION_ID,
        selfRemoval: true,
      });
      expect(cache.operations).not.toContain("applyEvent:reaction.added");
      expect(runtime.state.stale).toBe(true);
      expect(runtime.state.error).toBe("The workspace conversation catalog did not make progress");
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a permanent sync failure instead of silently going stale", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.syncResults.push({ status: "permanent", reason: "forbidden" });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    expect(runtime.state.error).toBe("This device is no longer allowed to sync this workspace.");
    expect(runtime.state.stale).toBe(true);
  });

  it("retries a retryable sync after the server's Retry-After delay", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("10"));
      api.syncResults.push({ status: "retryable", reason: "server", retryAfterMs: 2_000 });
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);
      expect(api.syncedFrom).toEqual(["10"]);
      expect(runtime.state.stale).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      await settle(() => api.syncedFrom.length === 2, "scheduled sync retry");
      expect(runtime.state.stale).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
