import type { NotificationActivityUpdate, NotificationState } from "@hype-comms/contracts";
import { describe, expect, it } from "vitest";

import {
  evaluateNotificationPolicy,
  isMessageVisibleAtLiveTail,
  type NotificationDeliveryContext,
  type NotificationPolicyEvent,
  type NotificationPolicyInput,
  type NotificationPolicySession,
  type NotificationWindowState,
} from "./notification-policy";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AUTHOR_ID = "10000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000003";
const OTHER_WORKSPACE_ID = "10000000-0000-4000-8000-000000000004";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000005";
const OTHER_CONVERSATION_ID = "10000000-0000-4000-8000-000000000006";
const THREAD_ROOT_ID = "10000000-0000-4000-8000-000000000007";
const OTHER_THREAD_ROOT_ID = "10000000-0000-4000-8000-000000000008";

const ACTIVE_SESSION = {
  state: "active",
  sessionGeneration: 7,
  rendererSessionGeneration: 3,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
} as const satisfies NotificationPolicySession;

const DELIVERY = {
  source: "live_realtime",
  sessionGeneration: ACTIVE_SESSION.sessionGeneration,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  connection: "armed_current",
  duplicate: false,
} as const satisfies NotificationDeliveryContext;

const DM_EVENT = {
  type: "message.created",
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  conversationKind: "direct_message",
  authorId: AUTHOR_ID,
  authorKind: "human",
  threadRootId: null,
  mentionedUserIds: [],
  recipientNotificationReason: null,
} as const satisfies NotificationPolicyEvent;

const WINDOW = {
  focused: false,
  shown: true,
  minimized: false,
} as const satisfies NotificationWindowState;

const ACTIVITY = {
  version: 1,
  sessionGeneration: ACTIVE_SESSION.sessionGeneration,
  rendererSessionGeneration: ACTIVE_SESSION.rendererSessionGeneration,
  revision: 5,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  view: {
    pane: "chat",
    conversationId: CONVERSATION_ID,
    timelineAtLiveTail: false,
    thread: null,
  },
} as const satisfies NotificationActivityUpdate;

const NOTIFICATION_STATE = {
  version: 1,
  devicePreference: "enabled",
  contentPreviewPreference: "disabled",
  nativeSupport: "supported",
  osPermission: "granted",
} as const satisfies NotificationState;

const BASE_INPUT = {
  event: DM_EVENT,
  session: ACTIVE_SESSION,
  delivery: DELIVERY,
  conversationState: "authorized",
  window: WINDOW,
  activity: ACTIVITY,
  notificationState: NOTIFICATION_STATE,
  headless: false,
} as const satisfies NotificationPolicyInput;

function withEvent(event: NotificationPolicyEvent): NotificationPolicyInput {
  return { ...BASE_INPUT, event };
}

function withDelivery(delivery: NotificationDeliveryContext): NotificationPolicyInput {
  return { ...BASE_INPUT, delivery };
}

function withSession(session: NotificationPolicySession): NotificationPolicyInput {
  return { ...BASE_INPUT, session };
}

function withActivity(
  activity: NotificationActivityUpdate | null,
  window: NotificationWindowState | null = WINDOW,
): NotificationPolicyInput {
  return { ...BASE_INPUT, activity, window };
}

describe("native notification eligibility policy", () => {
  it("notifies for a fresh incoming direct message", () => {
    expect(evaluateNotificationPolicy(BASE_INPUT)).toEqual({
      decision: "eligible",
      reason: "direct_message",
      presentation: "native",
    });
  });

  it("gives a server-verified mention precedence over direct-message eligibility", () => {
    expect(
      evaluateNotificationPolicy(
        withEvent({
          ...DM_EVENT,
          mentionedUserIds: [USER_ID],
        }),
      ),
    ).toEqual({ decision: "eligible", reason: "verified_mention", presentation: "native" });
  });

  it("notifies for a verified mention in a channel", () => {
    expect(
      evaluateNotificationPolicy(
        withEvent({
          ...DM_EVENT,
          conversationKind: "channel",
          mentionedUserIds: [USER_ID],
        }),
      ),
    ).toEqual({ decision: "eligible", reason: "verified_mention", presentation: "native" });
  });

  it("notifies for a server-authorized reply to a participated thread", () => {
    expect(
      evaluateNotificationPolicy(
        withEvent({
          ...DM_EVENT,
          conversationKind: "channel",
          threadRootId: THREAD_ROOT_ID,
          recipientNotificationReason: "participated_thread_reply",
        }),
      ),
    ).toEqual({
      decision: "eligible",
      reason: "participated_thread_reply",
      presentation: "native",
    });
  });

  it("applies mention, direct-message, then participated-thread precedence", () => {
    const participatedReply = {
      ...DM_EVENT,
      threadRootId: THREAD_ROOT_ID,
      recipientNotificationReason: "participated_thread_reply",
    } as const;
    expect(evaluateNotificationPolicy(withEvent(participatedReply))).toMatchObject({
      decision: "eligible",
      reason: "direct_message",
    });
    expect(
      evaluateNotificationPolicy(
        withEvent({
          ...participatedReply,
          conversationKind: "channel",
          mentionedUserIds: [USER_ID],
        }),
      ),
    ).toMatchObject({ decision: "eligible", reason: "verified_mention" });
  });

  it("does not infer participation locally or apply a thread reason to a root message", () => {
    expect(
      evaluateNotificationPolicy(
        withEvent({
          ...DM_EVENT,
          conversationKind: "channel",
          threadRootId: THREAD_ROOT_ID,
        }),
      ),
    ).toEqual({ decision: "suppressed", reason: "not_high_signal" });
    expect(
      evaluateNotificationPolicy(
        withEvent({
          ...DM_EVENT,
          conversationKind: "channel",
          recipientNotificationReason: "participated_thread_reply",
        }),
      ),
    ).toEqual({ decision: "suppressed", reason: "not_high_signal" });
  });

  it.each(["human", "bot", "agent"] as const)(
    "treats a %s-authored eligible message identically",
    (authorKind) => {
      expect(evaluateNotificationPolicy(withEvent({ ...DM_EVENT, authorKind }))).toMatchObject({
        decision: "eligible",
        reason: "direct_message",
      });
    },
  );

  it("does not infer a mention from message-like text outside the verified ID list", () => {
    const inputWithCanary = {
      ...withEvent({ ...DM_EVENT, conversationKind: "channel" }),
      event: {
        ...DM_EVENT,
        conversationKind: "channel",
        mentionedUserIds: [],
        body: `@morgan private-canary-${USER_ID}`,
      },
    } as unknown as NotificationPolicyInput;

    expect(evaluateNotificationPolicy(inputWithCanary)).toEqual({
      decision: "suppressed",
      reason: "not_high_signal",
    });
    expect(JSON.stringify(evaluateNotificationPolicy(inputWithCanary))).not.toContain(
      "private-canary",
    );
  });

  it.each([
    {
      name: "non-message event",
      input: withEvent({ type: "other" }),
      reason: "non_message_event",
    },
    {
      name: "signed-out scope",
      input: withSession({ state: "signed_out" }),
      reason: "signed_out",
    },
    {
      name: "replacing scope",
      input: withSession({ state: "replacing" }),
      reason: "session_replacing",
    },
    {
      name: "stale session generation",
      input: withDelivery({ ...DELIVERY, sessionGeneration: DELIVERY.sessionGeneration - 1 }),
      reason: "stale_generation",
    },
    {
      name: "wrong user scope",
      input: withDelivery({ ...DELIVERY, userId: AUTHOR_ID }),
      reason: "scope_mismatch",
    },
    {
      name: "wrong delivery workspace",
      input: withDelivery({ ...DELIVERY, workspaceId: OTHER_WORKSPACE_ID }),
      reason: "scope_mismatch",
    },
    {
      name: "wrong event workspace",
      input: withEvent({ ...DM_EVENT, workspaceId: OTHER_WORKSPACE_ID }),
      reason: "scope_mismatch",
    },
    {
      name: "startup or pre-live replay",
      input: withDelivery({ ...DELIVERY, source: "pre_live_replay" }),
      reason: "pre_live_replay",
    },
    {
      name: "HTTP catch-up",
      input: withDelivery({ ...DELIVERY, source: "http_catch_up" }),
      reason: "http_catch_up",
    },
    {
      name: "authoritative rebuild",
      input: withDelivery({ ...DELIVERY, source: "authoritative_rebuild" }),
      reason: "authoritative_rebuild",
    },
    {
      name: "disarmed connection",
      input: withDelivery({ ...DELIVERY, connection: "disarmed" }),
      reason: "connection_disarmed",
    },
    {
      name: "stale connection",
      input: withDelivery({ ...DELIVERY, connection: "stale" }),
      reason: "stale_connection",
    },
    {
      name: "duplicate delivery",
      input: withDelivery({ ...DELIVERY, duplicate: true }),
      reason: "duplicate_event",
    },
    {
      name: "blocked conversation",
      input: { ...BASE_INPUT, conversationState: "blocked" },
      reason: "conversation_blocked",
    },
    {
      name: "missing conversation projection",
      input: { ...BASE_INPUT, conversationState: "unknown" },
      reason: "conversation_metadata_unavailable",
    },
    {
      name: "reserved group DM",
      input: withEvent({
        ...DM_EVENT,
        conversationKind: "group_direct_message",
        mentionedUserIds: [USER_ID],
      }),
      reason: "unsupported_group_direct_message",
    },
    {
      name: "null author",
      input: withEvent({ ...DM_EVENT, authorId: null }),
      reason: "missing_author",
    },
    {
      name: "self-authored message",
      input: withEvent({ ...DM_EVENT, authorId: USER_ID }),
      reason: "self_authored",
    },
    {
      name: "ordinary channel message",
      input: withEvent({ ...DM_EVENT, conversationKind: "channel" }),
      reason: "not_high_signal",
    },
    {
      name: "focused window",
      input: { ...BASE_INPUT, window: { ...WINDOW, focused: true } },
      reason: "window_focused",
    },
    {
      name: "disabled device preference",
      input: {
        ...BASE_INPUT,
        notificationState: { ...NOTIFICATION_STATE, devicePreference: "disabled" },
      },
      reason: "device_disabled",
    },
    {
      name: "unsupported native capability",
      input: {
        ...BASE_INPUT,
        notificationState: { ...NOTIFICATION_STATE, nativeSupport: "unsupported" },
      },
      reason: "native_unsupported",
    },
    {
      name: "denied OS permission",
      input: {
        ...BASE_INPUT,
        notificationState: { ...NOTIFICATION_STATE, osPermission: "denied" },
      },
      reason: "permission_denied",
    },
  ] as const)("suppresses $name", ({ input, reason }) => {
    expect(evaluateNotificationPolicy(input)).toEqual({ decision: "suppressed", reason });
  });

  it("allows one presentation attempt while OS permission is unknown", () => {
    expect(
      evaluateNotificationPolicy({
        ...BASE_INPUT,
        notificationState: { ...NOTIFICATION_STATE, osPermission: "unknown" },
      }),
    ).toMatchObject({ decision: "eligible", presentation: "native" });
  });

  it("keeps content-preview preference out of eligibility and policy output", () => {
    const result = evaluateNotificationPolicy({
      ...BASE_INPUT,
      notificationState: {
        ...NOTIFICATION_STATE,
        contentPreviewPreference: "enabled",
      },
    });

    expect(result).toEqual({
      decision: "eligible",
      reason: "direct_message",
      presentation: "native",
    });
    expect(result).not.toHaveProperty("title");
    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("message");
  });

  it("routes headless eligibility to capture without consulting native host capability", () => {
    expect(
      evaluateNotificationPolicy({
        ...BASE_INPUT,
        headless: true,
        notificationState: {
          ...NOTIFICATION_STATE,
          nativeSupport: "unsupported",
          osPermission: "denied",
        },
      }),
    ).toEqual({
      decision: "eligible",
      reason: "direct_message",
      presentation: "capture",
    });

    expect(
      evaluateNotificationPolicy({
        ...BASE_INPUT,
        headless: true,
        notificationState: { ...NOTIFICATION_STATE, devicePreference: "disabled" },
      }),
    ).toEqual({ decision: "suppressed", reason: "device_disabled" });
  });
});

describe("native notification visibility policy", () => {
  it("suppresses a top-level message only when its main timeline is at the live tail", () => {
    const activity = {
      ...ACTIVITY,
      view: {
        pane: "chat",
        conversationId: CONVERSATION_ID,
        timelineAtLiveTail: true,
        thread: { rootId: THREAD_ROOT_ID, atLiveTail: false },
      },
    } as const satisfies NotificationActivityUpdate;

    expect(isMessageVisibleAtLiveTail(withActivity(activity))).toBe(true);
    expect(evaluateNotificationPolicy(withActivity(activity))).toEqual({
      decision: "suppressed",
      reason: "visible_at_live_tail",
    });
  });

  it("uses only the exact thread stream for a reply while the timeline remains visible", () => {
    const replyInput = withEvent({ ...DM_EVENT, threadRootId: THREAD_ROOT_ID });
    const matchingActivity = {
      ...ACTIVITY,
      view: {
        pane: "chat",
        conversationId: CONVERSATION_ID,
        timelineAtLiveTail: true,
        thread: { rootId: THREAD_ROOT_ID, atLiveTail: true },
      },
    } as const satisfies NotificationActivityUpdate;

    expect(isMessageVisibleAtLiveTail({ ...replyInput, activity: matchingActivity })).toBe(true);
    expect(evaluateNotificationPolicy({ ...replyInput, activity: matchingActivity })).toEqual({
      decision: "suppressed",
      reason: "visible_at_live_tail",
    });
    expect(
      isMessageVisibleAtLiveTail({
        ...replyInput,
        activity: {
          ...matchingActivity,
          view: { ...matchingActivity.view, thread: null },
        },
      }),
    ).toBe(false);
    expect(
      isMessageVisibleAtLiveTail({
        ...replyInput,
        activity: {
          ...matchingActivity,
          view: {
            ...matchingActivity.view,
            thread: { rootId: OTHER_THREAD_ROOT_ID, atLiveTail: true },
          },
        },
      }),
    ).toBe(false);
    expect(
      isMessageVisibleAtLiveTail({
        ...replyInput,
        activity: {
          ...matchingActivity,
          view: {
            ...matchingActivity.view,
            thread: { rootId: THREAD_ROOT_ID, atLiveTail: false },
          },
        },
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "selected conversation scrolled into history",
      activity: ACTIVITY,
      window: WINDOW,
    },
    {
      name: "Tasks pane",
      activity: {
        ...ACTIVITY,
        view: { pane: "tasks", conversationId: CONVERSATION_ID },
      },
      window: WINDOW,
    },
    {
      name: "different conversation",
      activity: {
        ...ACTIVITY,
        view: {
          pane: "chat",
          conversationId: OTHER_CONVERSATION_ID,
          timelineAtLiveTail: true,
          thread: null,
        },
      },
      window: WINDOW,
    },
    {
      name: "hidden window",
      activity: {
        ...ACTIVITY,
        view: { ...ACTIVITY.view, timelineAtLiveTail: true },
      },
      window: { ...WINDOW, shown: false },
    },
    {
      name: "minimized window",
      activity: {
        ...ACTIVITY,
        view: { ...ACTIVITY.view, timelineAtLiveTail: true },
      },
      window: { ...WINDOW, minimized: true },
    },
    {
      name: "unknown activity",
      activity: null,
      window: WINDOW,
    },
    {
      name: "stale auth generation",
      activity: { ...ACTIVITY, sessionGeneration: ACTIVE_SESSION.sessionGeneration - 1 },
      window: WINDOW,
    },
    {
      name: "stale renderer generation",
      activity: {
        ...ACTIVITY,
        rendererSessionGeneration: ACTIVE_SESSION.rendererSessionGeneration + 1,
      },
      window: WINDOW,
    },
    {
      name: "wrong activity user",
      activity: { ...ACTIVITY, userId: AUTHOR_ID },
      window: WINDOW,
    },
    {
      name: "wrong activity workspace",
      activity: { ...ACTIVITY, workspaceId: OTHER_WORKSPACE_ID },
      window: WINDOW,
    },
  ] as const)("treats $name as not currently visible", ({ activity, window }) => {
    const input = withActivity(activity, window);
    expect(isMessageVisibleAtLiveTail(input)).toBe(false);
    expect(evaluateNotificationPolicy(input)).toMatchObject({ decision: "eligible" });
  });
});
