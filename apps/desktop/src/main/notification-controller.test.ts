import type {
  ConversationSummary,
  NotificationAction,
  NotificationActionAcknowledgement,
  NotificationActionDrainRequest,
  NotificationActivityUpdate,
  NotificationState,
  ProductRealtimeEvent,
  User,
} from "@hmm-chat/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  NOTIFICATION_CONVERSATION_LIMIT,
  NOTIFICATION_HANDLED_EVENT_ID_LIMIT,
  NOTIFICATION_LIVE_HANDLE_LIMIT,
  NOTIFICATION_PENDING_PRESENTATION_LIMIT,
  NotificationController,
  type NotificationSettingsPort,
} from "./notification-controller";
import {
  CaptureNotificationPresenter,
  type NotificationPresentation,
  type NotificationPresentationCallbacks,
  type NotificationPresenter,
  type PresentedNotificationHandle,
} from "./notification-presenter";
import { NotificationSettingsController } from "./notification-settings-controller";

const NOW = "2026-08-10T12:00:00.000Z";

function id(value: number): string {
  return `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const USER_ID = id(1);
const AUTHOR_ID = id(2);
const OTHER_USER_ID = id(3);
const WORKSPACE_ID = id(4);
const OTHER_WORKSPACE_ID = id(5);
const CONVERSATION_ID = id(6);
const OTHER_CONVERSATION_ID = id(7);
const CONNECTION_ID = id(8);
const OTHER_CONNECTION_ID = id(9);

function user(userId: string, displayName: string, kind: User["kind"] = "human"): User {
  return {
    id: userId,
    kind,
    username: `user-${userId.slice(-4)}`,
    displayName,
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const CURRENT_USER = user(USER_ID, "Morgan");
const AUTHOR = user(AUTHOR_ID, "Claire");
const OTHER_USER = user(OTHER_USER_ID, "Woots", "agent");

function conversationSummary(options?: {
  readonly conversationId?: string;
  readonly kind?: "channel" | "direct_message" | "group_direct_message";
  readonly name?: string | null;
  readonly workspaceId?: string;
  readonly participantIds?: readonly string[];
}): ConversationSummary {
  const conversationId = options?.conversationId ?? CONVERSATION_ID;
  const kind = options?.kind ?? "direct_message";
  return {
    conversation: {
      id: conversationId,
      workspaceId: options?.workspaceId ?? WORKSPACE_ID,
      kind,
      name:
        options?.name === undefined ? (kind === "channel" ? "engineering" : null) : options.name,
      slug: kind === "channel" ? `channel-${conversationId.slice(-4)}` : null,
      topic: null,
      access: kind === "channel" ? "workspace" : null,
      isArchived: false,
      createdBy: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    participantIds: [...(options?.participantIds ?? [USER_ID, AUTHOR_ID])],
    membershipRole: null,
    lastMessage: null,
    unreadCount: 0,
    mentionCount: 0,
    readCursor: null,
  };
}

function connectedEvent(options?: {
  readonly eventId?: string;
  readonly connectionId?: string;
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly sequence?: string;
}): Extract<ProductRealtimeEvent, { type: "system.connected" }> {
  return {
    version: 1,
    id: options?.eventId ?? id(100),
    type: "system.connected",
    occurredAt: NOW,
    workspaceId: options?.workspaceId ?? WORKSPACE_ID,
    conversationId: null,
    workspaceSequence: options?.sequence ?? "5",
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: {
      connectionId: options?.connectionId ?? CONNECTION_ID,
      userId: options?.userId ?? USER_ID,
    },
  };
}

function messageEvent(options: {
  readonly eventNumber: number;
  readonly sequence: number;
  readonly messageNumber?: number;
  readonly conversationId?: string;
  readonly workspaceId?: string;
  readonly authorId?: string | null;
  readonly mentionedUserIds?: readonly string[];
  readonly recipientNotificationReason?: "participated_thread_reply";
  readonly threadRootId?: string | null;
  readonly body?: string;
}): Extract<ProductRealtimeEvent, { type: "message.created" }> {
  const conversationId = options.conversationId ?? CONVERSATION_ID;
  const sequence = String(options.sequence);
  const messageId = id(options.messageNumber ?? 10_000 + options.eventNumber);
  return {
    version: 1,
    id: id(20_000 + options.eventNumber),
    type: "message.created",
    occurredAt: NOW,
    workspaceId: options.workspaceId ?? WORKSPACE_ID,
    conversationId,
    workspaceSequence: sequence,
    conversationSequence: sequence,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: {
      message: {
        id: messageId,
        conversationId,
        conversationSequence: sequence,
        version: 1,
        clientMessageId: messageId,
        authorId: options.authorId === undefined ? AUTHOR_ID : options.authorId,
        threadRootId: options.threadRootId ?? null,
        body: options.body ?? `message-${String(options.eventNumber)}`,
        bodyFormat: "hmm_markdown_v1",
        editedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      mentionedUserIds: [...(options.mentionedUserIds ?? [])],
      ...(options.recipientNotificationReason === undefined
        ? {}
        : { recipientNotificationReason: options.recipientNotificationReason }),
    },
  };
}

function membershipRemovedEvent(sequence: number): ProductRealtimeEvent {
  return {
    version: 1,
    id: id(80_000 + sequence),
    type: "channel.membership_changed",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    conversationId: CONVERSATION_ID,
    workspaceSequence: String(sequence),
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { memberId: USER_ID, action: "removed" },
  };
}

function memberUpdatedEvent(sequence: number): ProductRealtimeEvent {
  return {
    version: 1,
    id: id(90_000 + sequence),
    type: "member.updated",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    conversationId: null,
    workspaceSequence: String(sequence),
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { member: { ...AUTHOR, displayName: "Stale label" } },
  };
}

function directConversationCreatedEvent(sequence: number): ProductRealtimeEvent {
  const summary = conversationSummary({
    conversationId: OTHER_CONVERSATION_ID,
    participantIds: [USER_ID, OTHER_USER_ID],
  });
  return {
    version: 1,
    id: id(95_000 + sequence),
    type: "direct_conversation.created",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    conversationId: summary.conversation.id,
    workspaceSequence: String(sequence),
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: {
      conversation: summary.conversation,
      participantIds: summary.participantIds,
    },
  };
}

class FakeSettings implements NotificationSettingsPort {
  state: NotificationState = {
    version: 1,
    devicePreference: "enabled",
    contentPreviewPreference: "disabled",
    nativeSupport: "supported",
    osPermission: "granted",
  };
  readonly markPresenterFailure = vi.fn((): NotificationState => {
    this.publish({ ...this.state, nativeSupport: "unsupported" });
    return this.state;
  });
  readonly #listeners = new Set<(state: NotificationState) => void>();

  subscribe(listener: (state: NotificationState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(state: NotificationState): void {
    this.state = state;
    for (const listener of this.#listeners) listener(state);
  }
}

class FakeHandle implements PresentedNotificationHandle {
  readonly close = vi.fn((): void => undefined);
}

interface FakePresentation {
  readonly presentation: NotificationPresentation;
  readonly callbacks: NotificationPresentationCallbacks;
  readonly handle: FakeHandle;
}

class FakePresenter implements NotificationPresenter {
  readonly kind: "native" | "capture";
  readonly presentations: FakePresentation[] = [];
  attempts = 0;
  failNext = false;

  constructor(kind: "native" | "capture" = "native") {
    this.kind = kind;
  }

  present(
    presentation: NotificationPresentation,
    callbacks: NotificationPresentationCallbacks,
  ): PresentedNotificationHandle {
    this.attempts += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("private presenter failure");
    }
    const handle = new FakeHandle();
    this.presentations.push({ presentation, callbacks, handle });
    return handle;
  }
}

function createHarness(options?: {
  readonly presenter?: NotificationPresenter;
  readonly settings?: FakeSettings;
  readonly headless?: boolean;
  readonly conversations?: readonly ConversationSummary[];
  readonly members?: readonly User[];
  readonly baseline?: string;
  readonly schedulePresentation?: (operation: () => void) => void;
}) {
  const presenter = options?.presenter ?? new FakePresenter();
  const settings = options?.settings ?? new FakeSettings();
  const windowState = { focused: false, shown: true, minimized: false };
  const click = vi.fn();
  const actionReady = vi.fn<(webContentsId: number, action: NotificationAction) => boolean>(
    () => true,
  );
  const repair = vi.fn();
  const controller = new NotificationController({
    presenter,
    settings,
    headless: options?.headless ?? false,
    getWindowState: () => ({ ...windowState }),
    onNotificationClick: click,
    onActionReady: actionReady,
    onRepairRequested: repair,
    ...(options?.schedulePresentation === undefined
      ? {}
      : { schedulePresentation: options.schedulePresentation }),
  });
  controller.startSession({
    sessionGeneration: 1,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    bootstrapCursor: options?.baseline ?? "5",
  });
  controller.replaceMembers(options?.members ?? [CURRENT_USER, AUTHOR, OTHER_USER]);
  controller.replaceConversations(options?.conversations ?? [conversationSummary()]);
  return { controller, presenter, settings, windowState, click, actionReady, repair };
}

function arm(controller: NotificationController, sequence = "5", connectionId = CONNECTION_ID) {
  return controller.handleEvent(connectedEvent({ sequence, connectionId }), {
    connectionId,
    sessionGeneration: 1,
  });
}

function rendererRequest(rendererSessionGeneration = 3): NotificationActionDrainRequest {
  return {
    version: 1,
    sessionGeneration: 1,
    rendererSessionGeneration,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
  };
}

function actionAcknowledgement(
  action: NotificationAction,
  rendererSessionGeneration = 3,
): NotificationActionAcknowledgement {
  return { ...rendererRequest(rendererSessionGeneration), action };
}

describe("NotificationController freshness and policy integration", () => {
  it("arms only at a matching system.connected boundary and keeps replay quiet", () => {
    const harness = createHarness();
    const presenter = harness.presenter as FakePresenter;

    const replay = harness.controller.handleEvent(messageEvent({ eventNumber: 1, sequence: 6 }));
    expect(replay).toMatchObject({
      status: "consumed",
      policy: { decision: "suppressed", reason: "pre_live_replay" },
    });
    expect(presenter.attempts).toBe(0);

    expect(
      harness.controller.handleEvent(connectedEvent({ userId: OTHER_USER_ID, sequence: "7" })),
    ).toEqual({ status: "rejected_boundary" });
    expect(harness.controller.diagnostics.connectionArmed).toBe(false);

    expect(arm(harness.controller, "10")).toEqual({ status: "armed" });
    const live = harness.controller.handleEvent(messageEvent({ eventNumber: 2, sequence: 11 }), {
      connectionId: CONNECTION_ID,
      sessionGeneration: 1,
    });
    expect(live).toMatchObject({
      status: "consumed",
      policy: { decision: "eligible", reason: "direct_message" },
      presentationAttempted: true,
    });
    expect(presenter.attempts).toBe(1);

    const stale = harness.controller.handleEvent(messageEvent({ eventNumber: 3, sequence: 12 }), {
      connectionId: OTHER_CONNECTION_ID,
    });
    expect(stale).toMatchObject({
      policy: { decision: "suppressed", reason: "stale_connection" },
    });

    harness.controller.setRealtimeState("reconnecting");
    const reconnectReplay = harness.controller.handleEvent(
      messageEvent({ eventNumber: 4, sequence: 13 }),
    );
    expect(reconnectReplay).toMatchObject({
      policy: { decision: "suppressed", reason: "pre_live_replay" },
    });
    expect(harness.controller.diagnostics.watermark).toBe("13");
  });

  it("passes metadata-only native content and queues an exact body-free click action", () => {
    const harness = createHarness();
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);
    const event = messageEvent({
      eventNumber: 10,
      sequence: 6,
      mentionedUserIds: [USER_ID],
      threadRootId: id(300),
      body: "private-body-canary",
    });

    harness.controller.handleEvent(event);
    expect(presenter.presentations[0]?.presentation).toEqual({
      title: "Claire",
      body: "Claire",
      reason: "verified_mention",
    });
    expect(JSON.stringify(presenter.presentations[0]?.presentation)).not.toContain(
      "private-body-canary",
    );

    presenter.presentations[0]?.callbacks.onClick();
    expect(harness.click).toHaveBeenCalledOnce();
    expect(harness.controller.diagnostics).toMatchObject({ pendingActions: 1, liveHandles: 0 });
    expect(presenter.presentations[0]?.handle.close).toHaveBeenCalledOnce();

    harness.controller.bindRenderer(42, 3);
    const response = harness.controller.rendererReadyAndDrain(42, rendererRequest());
    expect(response.actions).toEqual([
      {
        version: 1,
        type: "open-message",
        sessionGeneration: 1,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        conversationId: CONVERSATION_ID,
        messageId: event.payload.message.id,
        threadRootId: id(300),
      },
    ]);
    expect(harness.controller.diagnostics.pendingActions).toBe(1);
    expect(harness.controller.diagnostics.rendererReady).toBe(true);
    harness.controller.bindRenderer(42, 3);
    expect(harness.controller.diagnostics.rendererReady).toBe(true);
    expect(() => harness.controller.rendererReadyAndDrain(41, rendererRequest())).toThrow(
      /active renderer scope/u,
    );
    expect(
      harness.controller.acknowledgeAction(42, actionAcknowledgement(response.actions[0]!)),
    ).toBe(true);
    expect(harness.controller.diagnostics.pendingActions).toBe(0);

    harness.controller.handleEvent(messageEvent({ eventNumber: 11, sequence: 7 }));
    presenter.presentations[1]?.callbacks.onClick();
    harness.actionReady.mockReturnValueOnce(false);
    expect(harness.controller.deliverPendingToReadyRenderer()).toBe(0);
    expect(harness.controller.diagnostics.pendingActions).toBe(1);
    expect(harness.actionReady).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ messageId: id(10_011) }),
    );

    harness.actionReady.mockReturnValue(true);
    expect(harness.controller.deliverPendingToReadyRenderer()).toBe(1);
    expect(harness.controller.diagnostics.pendingActions).toBe(1);
    expect(harness.controller.deliverPendingToReadyRenderer()).toBe(1);
    const pushed = harness.actionReady.mock.calls.at(-1)?.[1];
    expect(pushed).toBeDefined();
    expect(harness.controller.acknowledgeAction(42, actionAcknowledgement(pushed!))).toBe(true);
    expect(harness.controller.diagnostics.pendingActions).toBe(0);
    harness.controller.invalidateRenderer(42);
    expect(harness.controller.diagnostics.rendererReady).toBe(false);
  });

  it("consumes a server-authorized participated-thread reason and opens the exact reply", () => {
    const harness = createHarness({
      conversations: [conversationSummary({ kind: "channel", name: "engineering" })],
    });
    const presenter = harness.presenter as FakePresenter;
    const threadRootId = id(301);
    arm(harness.controller);
    const event = messageEvent({
      eventNumber: 12,
      sequence: 6,
      threadRootId,
      recipientNotificationReason: "participated_thread_reply",
    });

    const first = harness.controller.handleEvent(event);
    expect(first).toMatchObject({
      status: "consumed",
      policy: { decision: "eligible", reason: "participated_thread_reply" },
      presentationAttempted: true,
    });
    expect(presenter.presentations[0]?.presentation).toEqual({
      title: "Claire",
      body: "engineering",
      reason: "participated_thread_reply",
    });

    expect(harness.controller.handleEvent(event)).toMatchObject({
      policy: { decision: "suppressed", reason: "duplicate_event" },
      presentationAttempted: false,
    });
    harness.controller.setRealtimeState("reconnecting");
    expect(
      harness.controller.handleEvent(
        messageEvent({
          eventNumber: 14,
          sequence: 7,
          threadRootId,
          recipientNotificationReason: "participated_thread_reply",
        }),
      ),
    ).toMatchObject({
      policy: { decision: "suppressed", reason: "pre_live_replay" },
      presentationAttempted: false,
    });
    expect(presenter.attempts).toBe(1);

    presenter.presentations[0]?.callbacks.onClick();
    harness.controller.bindRenderer(42, 3);
    expect(harness.controller.rendererReadyAndDrain(42, rendererRequest()).actions).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        messageId: event.payload.message.id,
        threadRootId,
      }),
    ]);
  });

  it("does not infer thread participation when an old server omits the recipient reason", () => {
    const harness = createHarness({
      conversations: [conversationSummary({ kind: "channel", name: "engineering" })],
    });
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);

    expect(
      harness.controller.handleEvent(
        messageEvent({ eventNumber: 13, sequence: 6, threadRootId: id(302) }),
      ),
    ).toMatchObject({
      policy: { decision: "suppressed", reason: "not_high_signal" },
      presentationAttempted: false,
    });
    expect(presenter.attempts).toBe(0);
  });

  it("retains drained and pushed actions across renderer invalidation until an exact ack", () => {
    const harness = createHarness();
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);
    harness.controller.handleEvent(messageEvent({ eventNumber: 20, sequence: 6 }));
    presenter.presentations[0]?.callbacks.onClick();

    harness.controller.bindRenderer(42, 3);
    const firstDrain = harness.controller.rendererReadyAndDrain(42, rendererRequest(3));
    expect(firstDrain.actions).toHaveLength(1);
    expect(harness.controller.diagnostics.pendingActions).toBe(1);

    harness.controller.invalidateRenderer(42);
    harness.controller.bindRenderer(43, 4);
    const reloadedDrain = harness.controller.rendererReadyAndDrain(43, rendererRequest(4));
    expect(reloadedDrain.actions).toEqual(firstDrain.actions);
    expect(() =>
      harness.controller.acknowledgeAction(42, actionAcknowledgement(firstDrain.actions[0]!, 3)),
    ).toThrow(/active renderer scope/u);
    expect(harness.controller.diagnostics.pendingActions).toBe(1);
    expect(
      harness.controller.acknowledgeAction(43, actionAcknowledgement(reloadedDrain.actions[0]!, 4)),
    ).toBe(true);
    expect(harness.controller.diagnostics.pendingActions).toBe(0);
  });

  it("removes only the exact acknowledged action and treats a repeated ack as idempotent", () => {
    const harness = createHarness();
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);
    harness.controller.handleEvent(messageEvent({ eventNumber: 30, sequence: 6 }));
    harness.controller.handleEvent(messageEvent({ eventNumber: 31, sequence: 7 }));
    presenter.presentations[0]?.callbacks.onClick();
    presenter.presentations[1]?.callbacks.onClick();
    harness.controller.bindRenderer(42, 3);
    const actions = harness.controller.rendererReadyAndDrain(42, rendererRequest()).actions;
    expect(actions).toHaveLength(2);

    const wrongTarget = {
      ...actions[0]!,
      messageId: id(999_999),
    };
    expect(harness.controller.acknowledgeAction(42, actionAcknowledgement(wrongTarget))).toBe(
      false,
    );
    expect(harness.controller.diagnostics.pendingActions).toBe(2);
    const otherScope = {
      ...actionAcknowledgement(actions[0]!),
      workspaceId: OTHER_WORKSPACE_ID,
      action: { ...actions[0]!, workspaceId: OTHER_WORKSPACE_ID },
    };
    expect(() => harness.controller.acknowledgeAction(42, otherScope)).toThrow(
      /active renderer scope/u,
    );
    expect(harness.controller.diagnostics.pendingActions).toBe(2);
    expect(harness.controller.acknowledgeAction(42, actionAcknowledgement(actions[0]!))).toBe(true);
    expect(harness.controller.diagnostics.pendingActions).toBe(1);
    expect(harness.controller.acknowledgeAction(42, actionAcknowledgement(actions[0]!))).toBe(
      false,
    );
    expect(harness.controller.diagnostics.pendingActions).toBe(1);
    expect(harness.controller.rendererReadyAndDrain(42, rendererRequest()).actions).toEqual([
      actions[1],
    ]);
  });

  it("keeps repeated push and acknowledgement cycles bounded for a long-lived renderer", () => {
    const harness = createHarness();
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);
    harness.controller.bindRenderer(42, 3);
    harness.controller.rendererReadyAndDrain(42, rendererRequest());

    for (let index = 0; index <= 128; index += 1) {
      harness.controller.handleEvent(
        messageEvent({ eventNumber: 1_000 + index, sequence: 6 + index }),
      );
      presenter.presentations[index]?.callbacks.onClick();
      expect(harness.controller.deliverPendingToReadyRenderer()).toBe(1);
      const pushed = harness.actionReady.mock.calls.at(-1)?.[1];
      expect(pushed).toBeDefined();
      expect(harness.controller.acknowledgeAction(42, actionAcknowledgement(pushed!))).toBe(true);
    }

    expect(harness.actionReady).toHaveBeenCalledTimes(129);
    expect(harness.controller.diagnostics).toMatchObject({ pendingActions: 0, liveHandles: 0 });
  });

  it("uses only sender-bound, increasing activity revisions for visibility", () => {
    const harness = createHarness({
      conversations: [conversationSummary({ kind: "channel", name: "engineering" })],
    });
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);
    harness.controller.bindRenderer(42, 3);
    const liveTail: NotificationActivityUpdate = {
      version: 1,
      sessionGeneration: 1,
      rendererSessionGeneration: 3,
      revision: 1,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      view: {
        pane: "chat",
        conversationId: CONVERSATION_ID,
        timelineAtLiveTail: true,
        thread: null,
      },
    };
    expect(harness.controller.updateActivity(42, liveTail)).toBe(true);
    harness.controller.bindRenderer(42, 3);
    expect(harness.controller.updateActivity(42, liveTail)).toBe(false);
    expect(harness.controller.updateActivity(99, { ...liveTail, revision: 2 })).toBe(false);

    const cleared = harness.controller.handleEvent(
      messageEvent({ eventNumber: 20, sequence: 6, mentionedUserIds: [USER_ID] }),
    );
    expect(cleared).toMatchObject({
      policy: { decision: "eligible", reason: "verified_mention" },
    });
    expect(presenter.attempts).toBe(1);

    expect(harness.controller.updateActivity(42, { ...liveTail, revision: 2 })).toBe(true);
    const visible = harness.controller.handleEvent(
      messageEvent({ eventNumber: 21, sequence: 7, mentionedUserIds: [USER_ID] }),
    );
    expect(visible).toMatchObject({
      policy: { decision: "suppressed", reason: "visible_at_live_tail" },
    });

    expect(
      harness.controller.updateActivity(42, {
        ...liveTail,
        revision: 3,
        view: { pane: "tasks", conversationId: CONVERSATION_ID },
      }),
    ).toBe(true);
    harness.controller.handleEvent(
      messageEvent({ eventNumber: 22, sequence: 8, mentionedUserIds: [USER_ID] }),
    );
    expect(presenter.attempts).toBe(2);

    harness.windowState.focused = true;
    const focused = harness.controller.handleEvent(
      messageEvent({ eventNumber: 23, sequence: 9, mentionedUserIds: [USER_ID] }),
    );
    expect(focused).toMatchObject({
      policy: { decision: "suppressed", reason: "window_focused" },
    });
    harness.controller.invalidateRenderer(42);
  });

  it("clears same-renderer visibility without lowering its activity revision or readiness", () => {
    const harness = createHarness({
      conversations: [conversationSummary({ kind: "channel", name: "engineering" })],
    });
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);
    harness.controller.bindRenderer(42, 3);
    harness.controller.rendererReadyAndDrain(42, rendererRequest());

    const liveTail: NotificationActivityUpdate = {
      version: 1,
      sessionGeneration: 1,
      rendererSessionGeneration: 3,
      revision: 19,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      view: {
        pane: "chat",
        conversationId: CONVERSATION_ID,
        timelineAtLiveTail: true,
        thread: null,
      },
    };
    expect(harness.controller.updateActivity(42, liveTail)).toBe(true);

    harness.controller.bindRenderer(42, 3);
    expect(harness.controller.diagnostics.rendererReady).toBe(true);
    const betweenBindings = harness.controller.handleEvent(
      messageEvent({ eventNumber: 23, sequence: 6, mentionedUserIds: [USER_ID] }),
    );
    expect(betweenBindings).toMatchObject({
      policy: { decision: "eligible", reason: "verified_mention" },
    });
    expect(presenter.attempts).toBe(1);

    expect(harness.controller.updateActivity(42, liveTail)).toBe(false);
    expect(
      harness.controller.updateActivity(42, {
        ...liveTail,
        revision: 20,
      }),
    ).toBe(true);
    const freshLiveTail = harness.controller.handleEvent(
      messageEvent({ eventNumber: 24, sequence: 7, mentionedUserIds: [USER_ID] }),
    );
    expect(freshLiveTail).toMatchObject({
      policy: { decision: "suppressed", reason: "visible_at_live_tail" },
    });
    expect(presenter.attempts).toBe(1);
  });

  it("consumes presenter failures once and resumes only after explicit capability recovery", () => {
    const harness = createHarness();
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);
    presenter.failNext = true;
    const event = messageEvent({ eventNumber: 30, sequence: 6 });

    const failed = harness.controller.handleEvent(event);
    expect(failed).toMatchObject({
      policy: { decision: "eligible" },
      presentationAttempted: true,
    });
    expect(harness.settings.markPresenterFailure).toHaveBeenCalledOnce();
    expect(harness.controller.diagnostics).toMatchObject({
      watermark: "6",
      presenterFailed: true,
    });

    const duplicate = harness.controller.handleEvent(event);
    expect(duplicate).toMatchObject({
      policy: { decision: "suppressed", reason: "duplicate_event" },
      presentationAttempted: false,
    });
    const disabled = harness.controller.handleEvent(messageEvent({ eventNumber: 31, sequence: 7 }));
    expect(disabled).toMatchObject({
      policy: { decision: "suppressed", reason: "native_unsupported" },
    });
    expect(presenter.attempts).toBe(1);

    harness.settings.publish({ ...harness.settings.state, nativeSupport: "supported" });
    harness.controller.handleEvent(messageEvent({ eventNumber: 32, sequence: 8 }));
    expect(presenter.attempts).toBe(2);
    presenter.presentations[0]?.callbacks.onFailure();
    expect(harness.controller.diagnostics.liveHandles).toBe(0);
  });
});

describe("NotificationController resource and lifecycle bounds", () => {
  it("defers presentation off delivery and drops scheduled work after scope teardown", () => {
    const scheduled: (() => void)[] = [];
    const harness = createHarness({
      schedulePresentation: (operation) => scheduled.push(operation),
      baseline: "0",
    });
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);

    const consumed = harness.controller.handleEvent(messageEvent({ eventNumber: 99, sequence: 6 }));
    expect(consumed).toMatchObject({
      status: "consumed",
      policy: { decision: "eligible" },
      presentationAttempted: true,
    });
    expect(harness.controller.diagnostics.watermark).toBe("6");
    expect(presenter.attempts).toBe(0);
    expect(scheduled).toHaveLength(1);

    harness.controller.signOut();
    scheduled[0]?.();
    expect(presenter.attempts).toBe(0);
  });

  it("coalesces and bounds pre-projected presentation work", () => {
    const scheduled: (() => void)[] = [];
    const harness = createHarness({
      schedulePresentation: (operation) => scheduled.push(operation),
      baseline: "0",
    });
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller, "0");

    for (let index = 1; index <= NOTIFICATION_PENDING_PRESENTATION_LIMIT + 1; index += 1) {
      harness.controller.handleEvent(messageEvent({ eventNumber: index, sequence: index }));
    }
    expect(scheduled).toHaveLength(1);
    expect(presenter.attempts).toBe(0);
    expect(harness.controller.diagnostics).toMatchObject({
      pendingPresentations: NOTIFICATION_PENDING_PRESENTATION_LIMIT,
      droppedPresentations: 1,
      watermark: String(NOTIFICATION_PENDING_PRESENTATION_LIMIT + 1),
    });

    scheduled.shift()?.();
    expect(presenter.attempts).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(harness.controller.diagnostics.pendingPresentations).toBe(
      NOTIFICATION_PENDING_PRESENTATION_LIMIT - 1,
    );
  });

  it("cancels a queued body preview when preview permission is revoked before presentation", () => {
    const settings = new FakeSettings();
    settings.state = { ...settings.state, contentPreviewPreference: "enabled" };
    const scheduled: (() => void)[] = [];
    const harness = createHarness({
      settings,
      schedulePresentation: (operation) => scheduled.push(operation),
    });
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);

    harness.controller.handleEvent(
      messageEvent({ eventNumber: 45, sequence: 6, body: "private-preview-canary" }),
    );
    expect(harness.controller.diagnostics.pendingPresentations).toBe(1);
    settings.publish({ ...settings.state, contentPreviewPreference: "disabled" });
    expect(harness.controller.diagnostics.pendingPresentations).toBe(0);

    scheduled[0]?.();
    expect(presenter.attempts).toBe(0);
  });

  it("closes live handles and cancels queued work when the device is disabled", () => {
    const settings = new FakeSettings();
    const scheduled: (() => void)[] = [];
    const harness = createHarness({ settings });
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);
    harness.controller.handleEvent(messageEvent({ eventNumber: 46, sequence: 6 }));
    expect(harness.controller.diagnostics.liveHandles).toBe(1);

    const queuedHarness = createHarness({
      settings,
      schedulePresentation: (operation) => scheduled.push(operation),
    });
    arm(queuedHarness.controller);
    queuedHarness.controller.handleEvent(messageEvent({ eventNumber: 47, sequence: 6 }));
    expect(queuedHarness.controller.diagnostics.pendingPresentations).toBe(1);

    settings.publish({ ...settings.state, devicePreference: "disabled" });
    expect(presenter.presentations[0]?.handle.close).toHaveBeenCalledOnce();
    expect(harness.controller.diagnostics.liveHandles).toBe(0);
    expect(queuedHarness.controller.diagnostics.pendingPresentations).toBe(0);
    scheduled[0]?.();
    expect((queuedHarness.presenter as FakePresenter).attempts).toBe(0);
  });

  it("cancels queued preview content before restrictive preference persistence settles", async () => {
    let rejectSave!: (error: unknown) => void;
    const savePending = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    const settings = new NotificationSettingsController({
      persistence: {
        load: async () => ({
          version: 1,
          devicePreference: "enabled",
          contentPreviewPreference: "enabled",
        }),
        save: () => savePending,
      },
      capability: {
        read: () => ({ nativeSupport: "supported", osPermission: "granted" }),
      },
    });
    await settings.initialize();
    const scheduled: (() => void)[] = [];
    const presenter = new FakePresenter();
    const controller = new NotificationController({
      presenter,
      settings,
      headless: false,
      getWindowState: () => ({ focused: false, shown: true, minimized: false }),
      schedulePresentation: (operation) => scheduled.push(operation),
    });
    controller.startSession({
      sessionGeneration: 1,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      bootstrapCursor: "5",
    });
    controller.replaceMembers([CURRENT_USER, AUTHOR]);
    controller.replaceConversations([conversationSummary()]);
    arm(controller);
    controller.handleEvent(
      messageEvent({ eventNumber: 48, sequence: 6, body: "private-persistence-canary" }),
    );
    expect(controller.diagnostics.pendingPresentations).toBe(1);

    const disabling = settings.setPreference({
      version: 1,
      devicePreference: "disabled",
      contentPreviewPreference: "disabled",
    });
    expect(controller.diagnostics.pendingPresentations).toBe(0);
    expect(settings.state).toMatchObject({
      devicePreference: "disabled",
      contentPreviewPreference: "disabled",
    });
    scheduled[0]?.();
    expect(presenter.attempts).toBe(0);

    const failedWrite = expect(disabling).rejects.toThrow("disk full");
    rejectSave(new Error("disk full"));
    await failedWrite;
    expect(settings.state).toMatchObject({
      devicePreference: "disabled",
      contentPreviewPreference: "disabled",
    });
    controller.shutdown();
    settings.dispose();
  });

  it("keeps the newest 1,024 event IDs without lowering the watermark", () => {
    const settings = new FakeSettings();
    settings.state = { ...settings.state, devicePreference: "disabled" };
    const harness = createHarness({ settings, baseline: "0" });
    arm(harness.controller, "0");

    for (let index = 1; index <= NOTIFICATION_HANDLED_EVENT_ID_LIMIT + 1; index += 1) {
      harness.controller.handleEvent(messageEvent({ eventNumber: index, sequence: index }));
    }
    expect(harness.controller.diagnostics).toMatchObject({
      watermark: String(NOTIFICATION_HANDLED_EVENT_ID_LIMIT + 1),
      handledEventIds: NOTIFICATION_HANDLED_EVENT_ID_LIMIT,
    });

    const evicted = harness.controller.handleEvent(
      messageEvent({
        eventNumber: 1,
        sequence: NOTIFICATION_HANDLED_EVENT_ID_LIMIT + 2,
      }),
    );
    expect(evicted).toMatchObject({
      policy: { decision: "suppressed", reason: "device_disabled" },
    });
    const retained = harness.controller.handleEvent(
      messageEvent({
        eventNumber: 3,
        sequence: NOTIFICATION_HANDLED_EVENT_ID_LIMIT + 3,
      }),
    );
    expect(retained).toMatchObject({
      policy: { decision: "suppressed", reason: "duplicate_event" },
    });
  });

  it("closes and evicts the oldest live native handle at 128 plus one", () => {
    const harness = createHarness();
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);

    for (let index = 1; index <= NOTIFICATION_LIVE_HANDLE_LIMIT + 1; index += 1) {
      harness.controller.handleEvent(messageEvent({ eventNumber: index, sequence: 5 + index }));
    }

    expect(presenter.presentations).toHaveLength(NOTIFICATION_LIVE_HANDLE_LIMIT + 1);
    expect(harness.controller.diagnostics.liveHandles).toBe(NOTIFICATION_LIVE_HANDLE_LIMIT);
    expect(presenter.presentations[0]?.handle.close).toHaveBeenCalledOnce();
    expect(presenter.presentations[1]?.handle.close).not.toHaveBeenCalled();
  });

  it("keeps the newest 32 clicked actions and reports only a drop counter", () => {
    const harness = createHarness();
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);

    for (let index = 1; index <= 33; index += 1) {
      harness.controller.handleEvent(messageEvent({ eventNumber: index, sequence: 5 + index }));
      presenter.presentations.at(-1)?.callbacks.onClick();
    }
    expect(harness.controller.diagnostics).toMatchObject({
      pendingActions: 32,
      droppedActions: 1,
      liveHandles: 0,
    });

    harness.controller.bindRenderer(42, 3);
    const actions = harness.controller.rendererReadyAndDrain(42, rendererRequest()).actions;
    expect(actions).toHaveLength(32);
    expect(actions[0]?.messageId).toBe(
      messageEvent({ eventNumber: 2, sequence: 7 }).payload.message.id,
    );
    expect(actions.at(-1)?.messageId).toBe(
      messageEvent({ eventNumber: 33, sequence: 38 }).payload.message.id,
    );
  });

  it("disables an overflowing conversation projection until authoritative replacement", () => {
    const harness = createHarness({ conversations: [] });
    const complete = Array.from({ length: NOTIFICATION_CONVERSATION_LIMIT }, (_, index) =>
      conversationSummary({ conversationId: id(100_000 + index) }),
    );
    expect(harness.controller.replaceConversations(complete)).toBe(true);
    expect(
      harness.controller.replaceConversations([
        ...complete,
        conversationSummary({ conversationId: id(200_000) }),
      ]),
    ).toBe(false);
    expect(harness.controller.diagnostics.projectionHealthy).toBe(false);
    expect(harness.repair).toHaveBeenCalledWith("conversations");

    arm(harness.controller);
    const suppressed = harness.controller.handleEvent(
      messageEvent({
        eventNumber: 50,
        sequence: 6,
        conversationId: complete[0]?.conversation.id,
      }),
    );
    expect(suppressed).toMatchObject({
      policy: { decision: "suppressed", reason: "conversation_metadata_unavailable" },
    });

    expect(harness.controller.replaceConversations([conversationSummary()])).toBe(true);
    expect(harness.controller.diagnostics.projectionHealthy).toBe(true);
  });

  it("requests a fresh catalog for a conversation event received during projection repair", () => {
    const harness = createHarness();

    harness.controller.disableConversationProjection();
    expect(harness.repair).toHaveBeenCalledTimes(1);
    harness.controller.handleEvent(directConversationCreatedEvent(6));

    expect(harness.controller.diagnostics.projectionHealthy).toBe(false);
    expect(harness.repair).toHaveBeenCalledTimes(2);
    expect(harness.repair).toHaveBeenLastCalledWith("conversations");
  });

  it("purges a removed conversation and keeps it blocked until catalog repair", () => {
    const second = conversationSummary({
      conversationId: OTHER_CONVERSATION_ID,
      participantIds: [USER_ID, OTHER_USER_ID],
    });
    const harness = createHarness({ conversations: [conversationSummary(), second] });
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);

    harness.controller.handleEvent(messageEvent({ eventNumber: 60, sequence: 6 }));
    harness.controller.handleEvent(
      messageEvent({
        eventNumber: 61,
        sequence: 7,
        conversationId: OTHER_CONVERSATION_ID,
        authorId: OTHER_USER_ID,
      }),
    );
    presenter.presentations[0]?.callbacks.onClick();
    presenter.presentations[1]?.callbacks.onClick();
    harness.controller.handleEvent(messageEvent({ eventNumber: 62, sequence: 8 }));
    harness.controller.handleEvent(
      messageEvent({
        eventNumber: 63,
        sequence: 9,
        conversationId: OTHER_CONVERSATION_ID,
        authorId: OTHER_USER_ID,
      }),
    );

    harness.controller.handleEvent(membershipRemovedEvent(10));
    expect(harness.controller.diagnostics).toMatchObject({
      pendingActions: 1,
      liveHandles: 1,
      blockedConversations: 1,
    });
    expect(presenter.presentations[2]?.handle.close).toHaveBeenCalledOnce();
    expect(presenter.presentations[3]?.handle.close).not.toHaveBeenCalled();
    expect(harness.repair).toHaveBeenCalledWith("conversations");

    const blocked = harness.controller.handleEvent(messageEvent({ eventNumber: 64, sequence: 11 }));
    expect(blocked).toMatchObject({
      policy: { decision: "suppressed", reason: "conversation_blocked" },
    });
    expect(harness.controller.replaceConversations([conversationSummary(), second])).toBe(true);
    harness.controller.handleEvent(messageEvent({ eventNumber: 65, sequence: 12 }));
    expect(presenter.attempts).toBe(5);
  });

  it("fails closed on member invalidation until an authoritative directory replacement", () => {
    const harness = createHarness();
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);
    harness.controller.handleEvent(messageEvent({ eventNumber: 80, sequence: 6 }));
    expect(harness.controller.diagnostics.liveHandles).toBe(1);

    harness.controller.handleEvent(memberUpdatedEvent(7));
    expect(harness.repair).toHaveBeenCalledWith("members");
    expect(harness.controller.diagnostics).toMatchObject({
      memberProjectionHealthy: false,
      liveHandles: 0,
    });
    expect(presenter.presentations[0]?.handle.close).toHaveBeenCalledOnce();

    const stale = harness.controller.handleEvent(messageEvent({ eventNumber: 81, sequence: 8 }));
    expect(stale).toMatchObject({
      policy: { decision: "suppressed", reason: "conversation_metadata_unavailable" },
    });
    expect(presenter.attempts).toBe(1);

    harness.controller.handleEvent(memberUpdatedEvent(9));
    expect(harness.repair).toHaveBeenCalledTimes(2);

    expect(harness.controller.replaceMembers([CURRENT_USER, AUTHOR, OTHER_USER])).toBe(true);
    const duplicateInvalidation = harness.controller.handleEvent(memberUpdatedEvent(7));
    expect(duplicateInvalidation).toMatchObject({ status: "consumed" });
    expect(harness.controller.diagnostics.memberProjectionHealthy).toBe(true);
    expect(harness.repair).toHaveBeenCalledTimes(2);
    harness.controller.handleEvent(messageEvent({ eventNumber: 82, sequence: 10 }));
    expect(presenter.attempts).toBe(2);
  });

  it("purges actions and live handles absent from an authoritative catalog replacement", () => {
    const first = conversationSummary();
    const second = conversationSummary({
      conversationId: OTHER_CONVERSATION_ID,
      participantIds: [USER_ID, OTHER_USER_ID],
    });
    const harness = createHarness({ conversations: [first, second] });
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);

    harness.controller.handleEvent(messageEvent({ eventNumber: 80, sequence: 6 }));
    presenter.presentations[0]?.callbacks.onClick();
    harness.controller.handleEvent(
      messageEvent({
        eventNumber: 81,
        sequence: 7,
        conversationId: OTHER_CONVERSATION_ID,
        authorId: OTHER_USER_ID,
      }),
    );
    presenter.presentations[1]?.callbacks.onClick();
    harness.controller.handleEvent(messageEvent({ eventNumber: 82, sequence: 8 }));
    harness.controller.handleEvent(
      messageEvent({
        eventNumber: 83,
        sequence: 9,
        conversationId: OTHER_CONVERSATION_ID,
        authorId: OTHER_USER_ID,
      }),
    );
    expect(harness.controller.diagnostics).toMatchObject({
      pendingActions: 2,
      liveHandles: 2,
    });

    expect(harness.controller.replaceConversations([first])).toBe(true);
    expect(harness.controller.diagnostics).toMatchObject({
      pendingActions: 1,
      liveHandles: 1,
    });
    expect(presenter.presentations[2]?.handle.close).not.toHaveBeenCalled();
    expect(presenter.presentations[3]?.handle.close).toHaveBeenCalledOnce();

    harness.controller.bindRenderer(42, 3);
    const actions = harness.controller.rendererReadyAndDrain(42, rendererRequest()).actions;
    expect(actions).toHaveLength(1);
    expect(actions[0]?.conversationId).toBe(CONVERSATION_ID);
  });

  it("closes and invalidates everything on scope replacement, sign-out, and shutdown", () => {
    const harness = createHarness();
    const presenter = harness.presenter as FakePresenter;
    arm(harness.controller);
    harness.controller.handleEvent(messageEvent({ eventNumber: 70, sequence: 6 }));
    const staleClick = presenter.presentations[0]?.callbacks.onClick;

    harness.controller.startSession({
      sessionGeneration: 2,
      userId: OTHER_USER_ID,
      workspaceId: OTHER_WORKSPACE_ID,
      bootstrapCursor: "2",
    });
    expect(presenter.presentations[0]?.handle.close).toHaveBeenCalledOnce();
    staleClick?.();
    expect(harness.controller.diagnostics).toMatchObject({
      watermark: "2",
      handledEventIds: 0,
      pendingActions: 0,
      liveHandles: 0,
      connectionArmed: false,
    });

    harness.controller.signOut();
    expect(
      harness.controller.handleEvent(messageEvent({ eventNumber: 71, sequence: 3 })),
    ).toMatchObject({ policy: { decision: "suppressed", reason: "signed_out" } });
    harness.controller.shutdown();
    expect(() => harness.controller.setRealtimeState("offline")).toThrow(/shut down/u);
  });
});

describe("NotificationController headless capture", () => {
  it("never records preview text or exact targets and activates through an opaque ID", () => {
    const settings = new FakeSettings();
    settings.state = {
      ...settings.state,
      contentPreviewPreference: "enabled",
      nativeSupport: "unsupported",
      osPermission: "denied",
    };
    const capture = new CaptureNotificationPresenter({ createId: () => "opaque-headless-1" });
    const harness = createHarness({ presenter: capture, settings, headless: true });
    arm(harness.controller);
    const event = messageEvent({
      eventNumber: 90,
      sequence: 6,
      body: "private-headless-body-canary",
    });

    const result = harness.controller.handleEvent(event);
    expect(result).toMatchObject({
      policy: { decision: "eligible", presentation: "capture" },
      presentationAttempted: true,
    });
    expect(capture.records).toEqual([
      { version: 1, captureId: "opaque-headless-1", reason: "direct_message" },
    ]);
    expect(JSON.stringify(capture.records)).not.toContain("private-headless-body-canary");
    expect(JSON.stringify(capture.records)).not.toContain(event.payload.message.id);

    expect(capture.activate("opaque-headless-1")).toBe(true);
    expect(harness.controller.diagnostics.pendingActions).toBe(1);
    expect(harness.click).toHaveBeenCalledOnce();
  });
});
