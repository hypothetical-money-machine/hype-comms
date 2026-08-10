import type {
  ConversationKind,
  NotificationActivityUpdate,
  NotificationState,
  UserKind,
} from "@hmm-chat/contracts";

export type NotificationEligibilityReason =
  "verified_mention" | "direct_message" | "participated_thread_reply";

export type NotificationSuppressionReason =
  | "non_message_event"
  | "signed_out"
  | "session_replacing"
  | "stale_generation"
  | "scope_mismatch"
  | "pre_live_replay"
  | "http_catch_up"
  | "authoritative_rebuild"
  | "connection_disarmed"
  | "stale_connection"
  | "duplicate_event"
  | "conversation_blocked"
  | "conversation_metadata_unavailable"
  | "unsupported_group_direct_message"
  | "missing_author"
  | "self_authored"
  | "not_high_signal"
  | "window_focused"
  | "visible_at_live_tail"
  | "device_disabled"
  | "native_unsupported"
  | "permission_denied";

export type NotificationPolicyResult =
  | {
      readonly decision: "eligible";
      readonly reason: NotificationEligibilityReason;
      readonly presentation: "native" | "capture";
    }
  | {
      readonly decision: "suppressed";
      readonly reason: NotificationSuppressionReason;
    };

export type NotificationPolicySession =
  | {
      readonly state: "active";
      readonly sessionGeneration: number;
      readonly rendererSessionGeneration: number | null;
      readonly userId: string;
      readonly workspaceId: string;
    }
  | {
      readonly state: "signed_out" | "replacing";
    };

export type NotificationDeliverySource =
  "live_realtime" | "pre_live_replay" | "http_catch_up" | "authoritative_rebuild";

export interface NotificationDeliveryContext {
  readonly source: NotificationDeliverySource;
  readonly sessionGeneration: number;
  readonly userId: string;
  readonly workspaceId: string;
  readonly connection: "armed_current" | "disarmed" | "stale";
  readonly duplicate: boolean;
}

export type NotificationPolicyEvent =
  | {
      readonly type: "message.created";
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly conversationKind: ConversationKind;
      readonly authorId: string | null;
      readonly authorKind: UserKind;
      readonly threadRootId: string | null;
      readonly mentionedUserIds: readonly string[];
      /** Null when an older server omits the capability-gated recipient projection. */
      readonly recipientNotificationReason: "participated_thread_reply" | null;
    }
  | {
      readonly type: "other";
    };

export interface NotificationWindowState {
  readonly focused: boolean;
  readonly shown: boolean;
  readonly minimized: boolean;
}

export interface NotificationPolicyInput {
  readonly event: NotificationPolicyEvent;
  readonly session: NotificationPolicySession;
  readonly delivery: NotificationDeliveryContext;
  readonly conversationState: "authorized" | "blocked" | "unknown";
  readonly window: NotificationWindowState | null;
  /** Null means no current, validated activity report exists for this renderer generation. */
  readonly activity: NotificationActivityUpdate | null;
  readonly notificationState: NotificationState;
  /** Headless mode records the eligible decision through a capture presenter, never a native one. */
  readonly headless: boolean;
}

function suppressed(reason: NotificationSuppressionReason): NotificationPolicyResult {
  return { decision: "suppressed", reason };
}

/**
 * Applies the exact event-time visibility rule. Activity has no wall-clock expiry: main either
 * supplies the latest scope- and sender-bound revision or invalidates it to null.
 */
export function isMessageVisibleAtLiveTail(input: NotificationPolicyInput): boolean {
  if (input.event.type !== "message.created" || input.session.state !== "active") return false;
  if (
    input.window === null ||
    !input.window.shown ||
    input.window.minimized ||
    input.activity === null ||
    input.session.rendererSessionGeneration === null
  ) {
    return false;
  }

  const activity = input.activity;
  if (
    activity.sessionGeneration !== input.session.sessionGeneration ||
    activity.rendererSessionGeneration !== input.session.rendererSessionGeneration ||
    activity.userId !== input.session.userId ||
    activity.workspaceId !== input.session.workspaceId ||
    activity.view.pane !== "chat"
  ) {
    return false;
  }

  if (activity.view.conversationId !== input.event.conversationId) return false;
  if (input.event.threadRootId === null) return activity.view.timelineAtLiveTail;

  return (
    activity.view.thread?.rootId === input.event.threadRootId && activity.view.thread.atLiveTail
  );
}

/**
 * Pure, body-free policy for the DM, verified-mention, and participated-thread slices. A
 * successful decision is only permission to attempt the injected presenter; it is not a durable
 * UI acknowledgement.
 */
export function evaluateNotificationPolicy(
  input: NotificationPolicyInput,
): NotificationPolicyResult {
  if (input.event.type !== "message.created") return suppressed("non_message_event");
  const session = input.session;
  if (session.state !== "active") {
    return suppressed(session.state === "signed_out" ? "signed_out" : "session_replacing");
  }

  if (input.delivery.sessionGeneration !== session.sessionGeneration) {
    return suppressed("stale_generation");
  }
  if (
    input.delivery.userId !== session.userId ||
    input.delivery.workspaceId !== session.workspaceId ||
    input.event.workspaceId !== session.workspaceId
  ) {
    return suppressed("scope_mismatch");
  }

  if (input.delivery.source === "pre_live_replay") return suppressed("pre_live_replay");
  if (input.delivery.source === "http_catch_up") return suppressed("http_catch_up");
  if (input.delivery.source === "authoritative_rebuild") {
    return suppressed("authoritative_rebuild");
  }
  if (input.delivery.connection === "disarmed") return suppressed("connection_disarmed");
  if (input.delivery.connection === "stale") return suppressed("stale_connection");
  if (input.delivery.duplicate) return suppressed("duplicate_event");

  if (input.conversationState === "blocked") return suppressed("conversation_blocked");
  if (input.conversationState === "unknown") {
    return suppressed("conversation_metadata_unavailable");
  }
  if (input.event.conversationKind === "group_direct_message") {
    return suppressed("unsupported_group_direct_message");
  }

  if (input.event.authorId === null) return suppressed("missing_author");
  if (input.event.authorId === session.userId) return suppressed("self_authored");

  let reason: NotificationEligibilityReason | null = null;
  if (input.event.mentionedUserIds.includes(session.userId)) {
    reason = "verified_mention";
  } else if (input.event.conversationKind === "direct_message") {
    reason = "direct_message";
  } else if (
    input.event.recipientNotificationReason === "participated_thread_reply" &&
    input.event.threadRootId !== null
  ) {
    reason = "participated_thread_reply";
  }
  if (reason === null) return suppressed("not_high_signal");

  if (input.window?.focused === true) return suppressed("window_focused");
  if (isMessageVisibleAtLiveTail(input)) return suppressed("visible_at_live_tail");
  if (input.notificationState.devicePreference === "disabled") {
    return suppressed("device_disabled");
  }
  if (input.headless) {
    return { decision: "eligible", reason, presentation: "capture" };
  }
  if (input.notificationState.nativeSupport === "unsupported") {
    return suppressed("native_unsupported");
  }
  if (input.notificationState.osPermission === "denied") {
    return suppressed("permission_denied");
  }

  return {
    decision: "eligible",
    reason,
    presentation: "native",
  };
}
