import {
  NOTIFICATION_PENDING_ACTION_LIMIT,
  entityIdSchema,
  notificationActionAcknowledgementSchema,
  notificationActionDrainRequestSchema,
  notificationActionDrainResponseSchema,
  notificationActionSchema,
  notificationActivityUpdateSchema,
  sequenceSchema,
  type ConversationKind,
  type ConversationSummary,
  type NotificationAction,
  type NotificationActionAcknowledgement,
  type NotificationActionDrainRequest,
  type NotificationActionDrainResponse,
  type NotificationActivityUpdate,
  type NotificationContext,
  type NotificationState,
  type ProductRealtimeEvent,
  type User,
  type UserKind,
} from "@hmm-chat/contracts";

import {
  evaluateNotificationPolicy,
  type NotificationDeliverySource,
  type NotificationPolicyEvent,
  type NotificationPolicyResult,
  type NotificationWindowState,
} from "./notification-policy";
import type { NotificationSettingsController } from "./notification-settings-controller";
import type {
  NotificationPresentation,
  NotificationPresenter,
  PresentedNotificationHandle,
} from "./notification-presenter";
import type { RealtimeConnectionState } from "./workspace-realtime";

export const NOTIFICATION_HANDLED_EVENT_ID_LIMIT = 1_024;
export const NOTIFICATION_LIVE_HANDLE_LIMIT = 128;
export const NOTIFICATION_PENDING_PRESENTATION_LIMIT = 128;
export const NOTIFICATION_CONVERSATION_LIMIT = 5_000;
const NOTIFICATION_TITLE_LIMIT = 120;
const NOTIFICATION_BODY_LIMIT = 240;
const NOTIFICATION_MEMBER_LIMIT = 25;

export interface NotificationSessionStart {
  readonly sessionGeneration: number;
  readonly userId: string;
  readonly workspaceId: string;
  readonly bootstrapCursor: string;
}

export interface NotificationEventContext {
  readonly source?: NotificationDeliverySource;
  readonly sessionGeneration?: number;
  readonly connectionId?: string;
}

export type NotificationEventResult =
  | { readonly status: "armed" }
  | { readonly status: "rejected_boundary" }
  | {
      readonly status: "consumed";
      readonly policy: NotificationPolicyResult;
      readonly presentationAttempted: boolean;
    };

export type NotificationRepairReason = "conversations" | "members";

export interface NotificationControllerDiagnostics {
  readonly watermark: string;
  readonly handledEventIds: number;
  readonly pendingActions: number;
  readonly pendingPresentations: number;
  readonly liveHandles: number;
  readonly droppedActions: number;
  readonly droppedPresentations: number;
  readonly blockedConversations: number;
  readonly memberProjectionHealthy: boolean;
  readonly projectionHealthy: boolean;
  readonly connectionArmed: boolean;
  readonly rendererReady: boolean;
  readonly presenterFailed: boolean;
}

export type NotificationSettingsPort = Pick<
  NotificationSettingsController,
  "state" | "markPresenterFailure" | "subscribe"
>;

interface ActiveSession {
  readonly sessionGeneration: number;
  readonly userId: string;
  readonly workspaceId: string;
}

interface RendererBinding {
  readonly webContentsId: number;
  readonly rendererSessionGeneration: number;
  revision: number;
  ready: boolean;
}

interface ProjectedConversation {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: ConversationKind;
  readonly name: string | null;
  readonly slug: string | null;
  readonly participantIds: readonly string[];
}

interface ProjectedMember {
  readonly displayName: string;
  readonly kind: UserKind;
}

interface LiveNotification {
  readonly handle: PresentedNotificationHandle;
  readonly action: NotificationAction;
}

interface PendingNotificationPresentation {
  readonly presentation: NotificationPresentation;
  readonly action: NotificationAction;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function boundedLabel(value: string, limit: number): string {
  return [...value].slice(0, limit).join("");
}

function maxSequence(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right;
}

function notificationActionKey(action: NotificationAction): string {
  return JSON.stringify([
    action.version,
    action.type,
    action.sessionGeneration,
    action.userId,
    action.workspaceId,
    action.conversationId,
    action.messageId,
    action.threadRootId,
  ]);
}

/**
 * Ephemeral, session-bound notification state. Nothing in this controller acknowledges renderer
 * work or mutates the durable sync/read cursors.
 */
export class NotificationController {
  readonly #presenter: NotificationPresenter;
  readonly #settings: NotificationSettingsPort;
  readonly #headless: boolean;
  readonly #getWindowState: () => NotificationWindowState | null;
  readonly #onNotificationClick: (() => void) | undefined;
  readonly #onActionReady:
    ((webContentsId: number, action: NotificationAction) => boolean) | undefined;
  readonly #onRepairRequested: ((reason: NotificationRepairReason) => void) | undefined;
  readonly #schedulePresentation: (operation: () => void) => void;
  readonly #stopSettingsSubscription: () => void;
  #sessionStatus: "active" | "signed_out" | "replacing" = "signed_out";
  #session: ActiveSession | null = null;
  #lastSessionGeneration = 0;
  #watermark = "0";
  #armedConnectionId: string | null = null;
  #handledEventIds = new Set<string>();
  #handledEventOrder: string[] = [];
  #conversations = new Map<string, ProjectedConversation>();
  #members = new Map<string, ProjectedMember>();
  #memberProjectionHealthy = true;
  #blockedConversations = new Set<string>();
  #projectionHealthy = true;
  #renderer: RendererBinding | null = null;
  #activity: NotificationActivityUpdate | null = null;
  #pendingActions: NotificationAction[] = [];
  #pendingPresentations: PendingNotificationPresentation[] = [];
  #presentationDrainScheduled = false;
  #presentationDrainEpoch = 0;
  #liveNotifications = new Map<number, LiveNotification>();
  #nextHandleId = 1;
  #droppedActions = 0;
  #droppedPresentations = 0;
  #presenterFailed = false;
  #lastSettingsState: NotificationState | null = null;
  #disposed = false;

  constructor(options: {
    readonly presenter: NotificationPresenter;
    readonly settings: NotificationSettingsPort;
    readonly headless: boolean;
    readonly getWindowState: () => NotificationWindowState | null;
    readonly onNotificationClick?: () => void;
    readonly onActionReady?: (webContentsId: number, action: NotificationAction) => boolean;
    readonly onRepairRequested?: (reason: NotificationRepairReason) => void;
    /** Production defers native OS work off realtime delivery; tests may keep the default. */
    readonly schedulePresentation?: (operation: () => void) => void;
  }) {
    if (options.headless !== (options.presenter.kind === "capture")) {
      throw new Error("Notification presenter kind does not match the desktop mode");
    }
    this.#presenter = options.presenter;
    this.#settings = options.settings;
    this.#headless = options.headless;
    this.#getWindowState = options.getWindowState;
    this.#onNotificationClick = options.onNotificationClick;
    this.#onActionReady = options.onActionReady;
    this.#onRepairRequested = options.onRepairRequested;
    this.#schedulePresentation = options.schedulePresentation ?? ((operation) => operation());
    try {
      this.#lastSettingsState = this.#settings.state;
    } catch {
      this.#lastSettingsState = null;
    }
    this.#stopSettingsSubscription = this.#settings.subscribe((state) => {
      const previous = this.#lastSettingsState;
      this.#lastSettingsState = state;
      if (state.nativeSupport === "supported") this.#presenterFailed = false;
      if (
        state.devicePreference === "disabled" ||
        state.nativeSupport === "unsupported" ||
        state.osPermission === "denied" ||
        (previous?.contentPreviewPreference === "enabled" &&
          state.contentPreviewPreference === "disabled")
      ) {
        // The OS side effect observes the latest device/privacy intent, not just the event-time
        // eligibility snapshot. In particular, never show a queued canonical body after preview
        // permission has been revoked.
        this.#cancelPendingPresentations();
        this.#closeAllNotifications();
      }
    });
  }

  get diagnostics(): NotificationControllerDiagnostics {
    return {
      watermark: this.#watermark,
      handledEventIds: this.#handledEventIds.size,
      pendingActions: this.#pendingActions.length,
      pendingPresentations: this.#pendingPresentations.length,
      liveHandles: this.#liveNotifications.size,
      droppedActions: this.#droppedActions,
      droppedPresentations: this.#droppedPresentations,
      blockedConversations: this.#blockedConversations.size,
      memberProjectionHealthy: this.#memberProjectionHealthy,
      projectionHealthy: this.#projectionHealthy,
      connectionArmed: this.#armedConnectionId !== null,
      rendererReady: this.#renderer?.ready ?? false,
      presenterFailed: this.#presenterFailed,
    };
  }

  startSession(input: NotificationSessionStart): void {
    this.#assertUsable();
    if (!isPositiveSafeInteger(input.sessionGeneration)) {
      throw new Error("Notification session generation must be a positive safe integer");
    }
    const bootstrapCursor = sequenceSchema.parse(input.bootstrapCursor);
    const userId = entityIdSchema.parse(input.userId);
    const workspaceId = entityIdSchema.parse(input.workspaceId);
    const current = this.#session;
    if (
      current !== null &&
      current.sessionGeneration === input.sessionGeneration &&
      current.userId === userId &&
      current.workspaceId === workspaceId
    ) {
      this.#watermark = maxSequence(this.#watermark, bootstrapCursor);
      return;
    }
    if (input.sessionGeneration <= this.#lastSessionGeneration) {
      throw new Error("Notification session generation must increase across scope replacement");
    }

    this.#clearScope();
    this.#lastSessionGeneration = input.sessionGeneration;
    this.#sessionStatus = "active";
    this.#session = {
      sessionGeneration: input.sessionGeneration,
      userId,
      workspaceId,
    };
    this.#watermark = bootstrapCursor;
  }

  markReplacing(): void {
    this.#assertUsable();
    this.#clearScope();
    this.#sessionStatus = "replacing";
  }

  signOut(): void {
    if (this.#disposed) return;
    this.#clearScope();
    this.#sessionStatus = "signed_out";
  }

  shutdown(): void {
    if (this.#disposed) return;
    this.#clearScope();
    this.#sessionStatus = "signed_out";
    this.#stopSettingsSubscription();
    this.#disposed = true;
  }

  setRealtimeState(state: RealtimeConnectionState): void {
    this.#assertUsable();
    if (state !== "live") this.#armedConnectionId = null;
  }

  bindRenderer(webContentsId: number, rendererSessionGeneration: number): NotificationContext {
    this.#assertUsable();
    const session = this.#requireActiveSession();
    if (!isPositiveSafeInteger(webContentsId)) {
      throw new Error("Notification renderer webContents ID must be a positive safe integer");
    }
    if (!isPositiveSafeInteger(rendererSessionGeneration)) {
      throw new Error("Notification renderer generation must be a positive safe integer");
    }
    if (
      this.#renderer?.webContentsId === webContentsId &&
      this.#renderer.rendererSessionGeneration === rendererSessionGeneration
    ) {
      // A same-renderer bind starts a new workspace delivery interval, so its prior visibility
      // snapshot is no longer authoritative. Preserve the monotonic revision fence and completed
      // action-ready handshake: delayed old reports remain rejected, while the renderer resumes
      // with its next lifetime-monotonic revision.
      this.#activity = null;
      return {
        version: 1,
        status: "active",
        sessionGeneration: session.sessionGeneration,
        rendererSessionGeneration,
        userId: session.userId,
        workspaceId: session.workspaceId,
      };
    }
    this.#renderer = {
      webContentsId,
      rendererSessionGeneration,
      revision: 0,
      ready: false,
    };
    this.#activity = null;
    return {
      version: 1,
      status: "active",
      sessionGeneration: session.sessionGeneration,
      rendererSessionGeneration,
      userId: session.userId,
      workspaceId: session.workspaceId,
    };
  }

  invalidateRenderer(webContentsId?: number): void {
    if (this.#renderer === null) return;
    if (webContentsId !== undefined && this.#renderer.webContentsId !== webContentsId) return;
    this.#renderer = null;
    this.#activity = null;
  }

  updateActivity(webContentsId: number, input: unknown): boolean {
    this.#assertUsable();
    const activity = notificationActivityUpdateSchema.parse(input);
    const session = this.#session;
    const renderer = this.#renderer;
    if (
      session === null ||
      renderer === null ||
      renderer.webContentsId !== webContentsId ||
      activity.sessionGeneration !== session.sessionGeneration ||
      activity.rendererSessionGeneration !== renderer.rendererSessionGeneration ||
      activity.userId !== session.userId ||
      activity.workspaceId !== session.workspaceId ||
      activity.revision <= renderer.revision
    ) {
      return false;
    }
    renderer.revision = activity.revision;
    this.#activity = activity;
    return true;
  }

  rendererReadyAndDrain(
    webContentsId: number,
    input: NotificationActionDrainRequest,
  ): NotificationActionDrainResponse {
    this.#assertUsable();
    const request = notificationActionDrainRequestSchema.parse(input);
    const session = this.#requireActiveSession();
    const renderer = this.#renderer;
    if (
      renderer === null ||
      renderer.webContentsId !== webContentsId ||
      request.sessionGeneration !== session.sessionGeneration ||
      request.rendererSessionGeneration !== renderer.rendererSessionGeneration ||
      request.userId !== session.userId ||
      request.workspaceId !== session.workspaceId
    ) {
      throw new Error("Notification action drain does not match the active renderer scope");
    }

    const actions = this.#pendingActions.filter(
      (action) =>
        this.#matchesCurrentAction(action) &&
        !this.#blockedConversations.has(action.conversationId) &&
        this.#conversations.has(action.conversationId),
    );
    const response = notificationActionDrainResponseSchema.parse({ ...request, actions });
    this.#pendingActions = actions;
    renderer.ready = true;
    return response;
  }

  acknowledgeAction(webContentsId: number, input: NotificationActionAcknowledgement): boolean {
    this.#assertUsable();
    const acknowledgement = notificationActionAcknowledgementSchema.parse(input);
    const session = this.#requireActiveSession();
    const renderer = this.#renderer;
    if (
      renderer === null ||
      !renderer.ready ||
      renderer.webContentsId !== webContentsId ||
      acknowledgement.sessionGeneration !== session.sessionGeneration ||
      acknowledgement.rendererSessionGeneration !== renderer.rendererSessionGeneration ||
      acknowledgement.userId !== session.userId ||
      acknowledgement.workspaceId !== session.workspaceId
    ) {
      throw new Error(
        "Notification action acknowledgement does not match the active renderer scope",
      );
    }

    const key = notificationActionKey(acknowledgement.action);
    const index = this.#pendingActions.findIndex((action) => notificationActionKey(action) === key);
    if (index < 0) return false;
    this.#pendingActions.splice(index, 1);
    return true;
  }

  /** Pushes only after the renderer's initial ready-and-drain handshake has completed. */
  deliverPendingToReadyRenderer(): number {
    this.#assertUsable();
    const renderer = this.#renderer;
    if (!renderer?.ready || this.#onActionReady === undefined) return 0;

    this.#pendingActions = this.#pendingActions.filter(
      (action) =>
        this.#matchesCurrentAction(action) &&
        !this.#blockedConversations.has(action.conversationId) &&
        this.#conversations.has(action.conversationId),
    );
    let delivered = 0;
    for (const action of this.#pendingActions) {
      let accepted: boolean;
      try {
        accepted = this.#onActionReady(renderer.webContentsId, action);
      } catch {
        break;
      }
      if (!accepted) break;
      delivered += 1;
      if (this.#renderer !== renderer || !renderer.ready) break;
    }
    return delivered;
  }

  replaceMembers(members: readonly User[]): boolean {
    this.#assertUsable();
    const session = this.#requireActiveSession();
    if (members.length > NOTIFICATION_MEMBER_LIMIT) {
      this.#disableMemberProjection();
      return false;
    }
    const replacement = new Map<string, ProjectedMember>();
    for (const member of members) {
      if (replacement.has(member.id)) {
        this.#disableMemberProjection();
        return false;
      }
      replacement.set(member.id, { displayName: member.displayName, kind: member.kind });
    }
    if (!replacement.has(session.userId)) {
      this.#disableMemberProjection();
      return false;
    }
    this.#members = replacement;
    this.#memberProjectionHealthy = true;
    return true;
  }

  replaceConversations(conversations: readonly ConversationSummary[]): boolean {
    this.#assertUsable();
    const session = this.#requireActiveSession();
    if (conversations.length > NOTIFICATION_CONVERSATION_LIMIT) {
      this.#disableProjection();
      return false;
    }
    const replacement = new Map<string, ProjectedConversation>();
    for (const summary of conversations) {
      const projected = this.#projectConversation(summary);
      if (projected.workspaceId !== session.workspaceId || replacement.has(projected.id)) {
        this.#disableProjection();
        return false;
      }
      replacement.set(projected.id, projected);
    }

    this.#pendingActions = this.#pendingActions.filter((action) =>
      replacement.has(action.conversationId),
    );
    this.#pendingPresentations = this.#pendingPresentations.filter((pending) =>
      replacement.has(pending.action.conversationId),
    );
    for (const [handleId, notification] of this.#liveNotifications) {
      if (!replacement.has(notification.action.conversationId)) {
        this.#removeLiveNotification(handleId, true);
      }
    }
    this.#conversations = replacement;
    this.#projectionHealthy = true;
    for (const conversationId of replacement.keys()) {
      this.#blockedConversations.delete(conversationId);
    }
    return true;
  }

  disableConversationProjection(): void {
    this.#assertUsable();
    this.#disableProjection();
  }

  invalidateMemberProjection(): void {
    this.#assertUsable();
    this.#requireActiveSession();
    this.#disableMemberProjection();
  }

  blockConversation(conversationId: string): void {
    this.#assertUsable();
    const parsedConversationId = entityIdSchema.parse(conversationId);
    if (this.#blockedConversations.size < NOTIFICATION_CONVERSATION_LIMIT) {
      this.#blockedConversations.add(parsedConversationId);
    }
    this.#pendingActions = this.#pendingActions.filter(
      (action) => action.conversationId !== parsedConversationId,
    );
    this.#pendingPresentations = this.#pendingPresentations.filter(
      (pending) => pending.action.conversationId !== parsedConversationId,
    );
    for (const [handleId, notification] of this.#liveNotifications) {
      if (notification.action.conversationId === parsedConversationId) {
        this.#removeLiveNotification(handleId, true);
      }
    }
  }

  handleEvent(
    event: ProductRealtimeEvent,
    context: NotificationEventContext = {},
  ): NotificationEventResult {
    this.#assertUsable();
    if (event.type === "system.connected") return this.#handleConnected(event, context);

    const session = this.#session;
    if (session === null || this.#sessionStatus !== "active") {
      return {
        status: "consumed",
        policy: {
          decision: "suppressed",
          reason: this.#sessionStatus === "replacing" ? "session_replacing" : "signed_out",
        },
        presentationAttempted: false,
      };
    }

    const duplicate = this.#isDuplicate(event);
    if (!duplicate) this.#applyMetadataInvalidation(event, session);
    const source =
      context.source ?? (this.#armedConnectionId === null ? "pre_live_replay" : "live_realtime");
    const connection =
      this.#armedConnectionId === null
        ? "disarmed"
        : context.connectionId !== undefined && context.connectionId !== this.#armedConnectionId
          ? "stale"
          : "armed_current";
    const policyEvent = this.#policyEvent(event);
    const conversationState = this.#conversationState(event, session);
    let windowState: NotificationWindowState | null;
    try {
      windowState = this.#getWindowState();
    } catch {
      // A window-state failure must be quiet rather than assuming the message is unseen.
      windowState = { focused: true, shown: false, minimized: false };
    }
    let notificationState;
    try {
      notificationState = this.#settings.state;
    } catch {
      notificationState = {
        version: 1,
        devicePreference: "disabled",
        contentPreviewPreference: "disabled",
        nativeSupport: "unsupported",
        osPermission: "unknown",
      } as const;
    }
    const policy = evaluateNotificationPolicy({
      event: policyEvent,
      session: {
        state: "active",
        sessionGeneration: session.sessionGeneration,
        rendererSessionGeneration: this.#renderer?.rendererSessionGeneration ?? null,
        userId: session.userId,
        workspaceId: session.workspaceId,
      },
      delivery: {
        source,
        sessionGeneration: context.sessionGeneration ?? session.sessionGeneration,
        userId: session.userId,
        workspaceId: session.workspaceId,
        connection,
        duplicate,
      },
      conversationState,
      window: windowState,
      activity: this.#activity,
      notificationState,
      headless: this.#headless,
    });

    let presentationAttempted = false;
    if (
      policy.decision === "eligible" &&
      !this.#presenterFailed &&
      event.type === "message.created"
    ) {
      const pending = this.#prepareMessagePresentation(event, policy.reason, session);
      if (pending !== null) presentationAttempted = this.#enqueuePresentation(pending);
    }
    this.#rememberEvent(event);
    return { status: "consumed", policy, presentationAttempted };
  }

  #handleConnected(
    event: Extract<ProductRealtimeEvent, { type: "system.connected" }>,
    context: NotificationEventContext,
  ): NotificationEventResult {
    const session = this.#session;
    if (
      session === null ||
      this.#sessionStatus !== "active" ||
      event.workspaceId !== session.workspaceId ||
      event.payload.userId !== session.userId ||
      (context.sessionGeneration !== undefined &&
        context.sessionGeneration !== session.sessionGeneration) ||
      (context.connectionId !== undefined && context.connectionId !== event.payload.connectionId)
    ) {
      this.#armedConnectionId = null;
      return { status: "rejected_boundary" };
    }

    this.#armedConnectionId = event.payload.connectionId;
    this.#rememberEvent(event);
    return { status: "armed" };
  }

  #policyEvent(event: ProductRealtimeEvent): NotificationPolicyEvent {
    if (event.type !== "message.created") return { type: "other" };
    const conversation = this.#conversations.get(event.conversationId);
    const member =
      event.payload.message.authorId === null
        ? null
        : (this.#members.get(event.payload.message.authorId) ?? null);
    return {
      type: "message.created",
      workspaceId: event.workspaceId,
      conversationId: event.conversationId,
      conversationKind: conversation?.kind ?? "channel",
      authorId: event.payload.message.authorId,
      authorKind: member?.kind ?? "human",
      threadRootId: event.payload.message.threadRootId,
      mentionedUserIds: event.payload.mentionedUserIds,
    };
  }

  #conversationState(
    event: ProductRealtimeEvent,
    session: ActiveSession,
  ): "authorized" | "blocked" | "unknown" {
    if (event.conversationId !== null && this.#blockedConversations.has(event.conversationId)) {
      return "blocked";
    }
    if (event.type !== "message.created") return "authorized";
    if (!this.#projectionHealthy || !this.#memberProjectionHealthy) return "unknown";
    const conversation = this.#conversations.get(event.conversationId);
    const message = event.payload.message;
    if (
      conversation === undefined ||
      conversation.workspaceId !== session.workspaceId ||
      message.conversationId !== event.conversationId ||
      message.conversationSequence !== event.conversationSequence ||
      message.threadRootId === message.id ||
      message.deletedAt !== null
    ) {
      return "unknown";
    }
    if (
      message.authorId !== null &&
      message.authorId !== session.userId &&
      !this.#members.has(message.authorId)
    ) {
      return "unknown";
    }
    if (
      conversation.kind !== "group_direct_message" &&
      this.#conversationLabel(conversation, session) === null
    ) {
      return "unknown";
    }
    return "authorized";
  }

  #prepareMessagePresentation(
    event: Extract<ProductRealtimeEvent, { type: "message.created" }>,
    reason: "verified_mention" | "direct_message",
    session: ActiveSession,
  ): PendingNotificationPresentation | null {
    if (
      this.#session !== session ||
      this.#sessionStatus !== "active" ||
      this.#blockedConversations.has(event.conversationId)
    ) {
      return null;
    }
    const conversation = this.#conversations.get(event.conversationId);
    const authorId = event.payload.message.authorId;
    const author = authorId === null ? undefined : this.#members.get(authorId);
    if (conversation === undefined || author === undefined) return null;
    const conversationLabel = this.#conversationLabel(conversation, session);
    if (conversationLabel === null) return null;

    const action = notificationActionSchema.safeParse({
      version: 1,
      type: "open-message",
      sessionGeneration: session.sessionGeneration,
      userId: session.userId,
      workspaceId: session.workspaceId,
      conversationId: event.conversationId,
      messageId: event.payload.message.id,
      threadRootId: event.payload.message.threadRootId,
    });
    if (!action.success) return null;
    let previewEnabled: boolean;
    try {
      previewEnabled =
        !this.#headless && this.#settings.state.contentPreviewPreference === "enabled";
    } catch {
      previewEnabled = false;
    }
    return {
      presentation: {
        title: boundedLabel(author.displayName, NOTIFICATION_TITLE_LIMIT),
        body: boundedLabel(
          previewEnabled ? event.payload.message.body : conversationLabel,
          NOTIFICATION_BODY_LIMIT,
        ),
        reason,
      },
      action: action.data,
    };
  }

  #enqueuePresentation(pending: PendingNotificationPresentation): boolean {
    if (this.#pendingPresentations.length >= NOTIFICATION_PENDING_PRESENTATION_LIMIT) {
      this.#pendingPresentations.shift();
      this.#droppedPresentations += 1;
    }
    this.#pendingPresentations.push(pending);
    if (this.#presentationDrainScheduled) return true;
    return this.#schedulePresentationDrain();
  }

  #schedulePresentationDrain(): boolean {
    const epoch = this.#presentationDrainEpoch;
    this.#presentationDrainScheduled = true;
    try {
      this.#schedulePresentation(() => {
        if (epoch === this.#presentationDrainEpoch) this.#drainOnePresentation();
      });
      return true;
    } catch {
      this.#presentationDrainScheduled = false;
      this.#pendingPresentations = [];
      this.#markPresenterFailure();
      return false;
    }
  }

  #drainOnePresentation(): void {
    this.#presentationDrainScheduled = false;
    if (this.#disposed || this.#presenterFailed) {
      this.#pendingPresentations = [];
      return;
    }
    const pending = this.#pendingPresentations.shift();
    if (
      pending !== undefined &&
      this.#matchesCurrentAction(pending.action) &&
      !this.#blockedConversations.has(pending.action.conversationId) &&
      this.#conversations.has(pending.action.conversationId)
    ) {
      this.#presentPreparedMessage(pending);
    }
    if (this.#pendingPresentations.length > 0 && !this.#disposed && !this.#presenterFailed) {
      this.#schedulePresentationDrain();
    }
  }

  #presentPreparedMessage(pending: PendingNotificationPresentation): void {
    const { action, presentation } = pending;

    const handleId = this.#nextHandleId;
    this.#nextHandleId += 1;
    let terminal = false;
    const once = (operation: () => void): void => {
      if (terminal) return;
      terminal = true;
      operation();
    };

    let handle: PresentedNotificationHandle;
    try {
      handle = this.#presenter.present(presentation, {
        onClick: () => once(() => this.#handleClick(handleId, action)),
        onClose: () => once(() => this.#removeLiveNotification(handleId, false)),
        onFailure: () =>
          once(() => {
            this.#removeLiveNotification(handleId, true);
            this.#markPresenterFailure();
          }),
      });
    } catch {
      this.#markPresenterFailure();
      return;
    }

    if (
      terminal ||
      !this.#matchesCurrentAction(action) ||
      this.#blockedConversations.has(action.conversationId)
    ) {
      this.#closeHandle(handle);
      return;
    }
    this.#liveNotifications.set(handleId, { handle, action });
    while (this.#liveNotifications.size > NOTIFICATION_LIVE_HANDLE_LIMIT) {
      const oldest = this.#liveNotifications.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#removeLiveNotification(oldest, true);
    }
  }

  #handleClick(handleId: number, action: NotificationAction): void {
    this.#removeLiveNotification(handleId, true);
    if (
      !this.#matchesCurrentAction(action) ||
      this.#blockedConversations.has(action.conversationId) ||
      !this.#conversations.has(action.conversationId)
    ) {
      return;
    }
    this.#pendingActions.push(action);
    if (this.#pendingActions.length > NOTIFICATION_PENDING_ACTION_LIMIT) {
      this.#pendingActions.shift();
      this.#droppedActions += 1;
    }
    try {
      this.#onNotificationClick?.();
    } catch {
      // The exact action stays queued even if restoring/focusing the window fails synchronously.
    }
  }

  #applyMetadataInvalidation(event: ProductRealtimeEvent, session: ActiveSession): void {
    if (
      event.type === "channel.created" ||
      event.type === "channel.archived" ||
      event.type === "direct_conversation.created"
    ) {
      this.#appendProjectedConversation({
        id: event.payload.conversation.id,
        workspaceId: event.payload.conversation.workspaceId,
        kind: event.payload.conversation.kind,
        name: event.payload.conversation.name,
        slug: event.payload.conversation.slug,
        participantIds: [...event.payload.participantIds],
      });
      return;
    }
    if (event.type === "member.updated") {
      this.#disableMemberProjection();
      return;
    }
    if (event.type === "channel.membership_changed") {
      if (event.payload.memberId === session.userId && event.payload.action === "removed") {
        this.blockConversation(event.conversationId);
      }
      this.#requestRepair("conversations");
    }
  }

  #appendProjectedConversation(conversation: ProjectedConversation): void {
    const session = this.#session;
    if (!this.#projectionHealthy) {
      // An ordered conversation event that lands during an older HTTP catalog read makes that
      // response stale even though the event payload itself is canonical. Force a fresh complete
      // catalog before presentation is re-enabled so the older response cannot replace this event.
      this.#requestRepair("conversations");
      return;
    }
    if (
      session === null ||
      conversation.workspaceId !== session.workspaceId ||
      (!this.#conversations.has(conversation.id) &&
        this.#conversations.size >= NOTIFICATION_CONVERSATION_LIMIT)
    ) {
      this.#disableProjection();
      return;
    }
    this.#conversations.set(conversation.id, conversation);
  }

  #projectConversation(summary: ConversationSummary): ProjectedConversation {
    return {
      id: summary.conversation.id,
      workspaceId: summary.conversation.workspaceId,
      kind: summary.conversation.kind,
      name: summary.conversation.name,
      slug: summary.conversation.slug,
      participantIds: [...summary.participantIds],
    };
  }

  #conversationLabel(conversation: ProjectedConversation, session: ActiveSession): string | null {
    if (conversation.kind === "channel") return conversation.name ?? conversation.slug;
    const otherParticipant = conversation.participantIds.find(
      (participantId) => participantId !== session.userId,
    );
    if (otherParticipant === undefined) return null;
    return this.#members.get(otherParticipant)?.displayName ?? null;
  }

  #isDuplicate(event: ProductRealtimeEvent): boolean {
    return (
      this.#handledEventIds.has(event.id) ||
      BigInt(event.workspaceSequence) <= BigInt(this.#watermark)
    );
  }

  #rememberEvent(event: ProductRealtimeEvent): void {
    this.#watermark = maxSequence(this.#watermark, event.workspaceSequence);
    if (this.#handledEventIds.has(event.id)) return;
    this.#handledEventIds.add(event.id);
    this.#handledEventOrder.push(event.id);
    while (this.#handledEventOrder.length > NOTIFICATION_HANDLED_EVENT_ID_LIMIT) {
      const oldest = this.#handledEventOrder.shift();
      if (oldest !== undefined) this.#handledEventIds.delete(oldest);
    }
  }

  #matchesCurrentAction(action: NotificationAction): boolean {
    const session = this.#session;
    return (
      session !== null &&
      this.#sessionStatus === "active" &&
      action.sessionGeneration === session.sessionGeneration &&
      action.userId === session.userId &&
      action.workspaceId === session.workspaceId
    );
  }

  #removeLiveNotification(handleId: number, close: boolean): void {
    const notification = this.#liveNotifications.get(handleId);
    if (notification === undefined) return;
    this.#liveNotifications.delete(handleId);
    if (close) this.#closeHandle(notification.handle);
  }

  #closeHandle(handle: PresentedNotificationHandle): void {
    try {
      handle.close();
    } catch {
      // Cleanup is best-effort and must not surface notification content or block session teardown.
    }
  }

  #closeAllNotifications(): void {
    const notifications = [...this.#liveNotifications.values()];
    this.#liveNotifications.clear();
    for (const notification of notifications) this.#closeHandle(notification.handle);
  }

  #disableProjection(): void {
    const shouldRequest = this.#projectionHealthy;
    this.#projectionHealthy = false;
    if (shouldRequest) this.#requestRepair("conversations");
  }

  #disableMemberProjection(): void {
    this.#memberProjectionHealthy = false;
    this.#members.clear();
    this.#cancelPendingPresentations();
    this.#closeAllNotifications();
    // Every ordered invalidation matters. If another `member.updated` arrives while an HTTP
    // repair is in flight, the coordinator marks that read superseded and follows it with a fresh
    // authoritative request before this projection can become healthy again.
    this.#requestRepair("members");
  }

  #requestRepair(reason: NotificationRepairReason): void {
    try {
      this.#onRepairRequested?.(reason);
    } catch {
      // Repair scheduling is external and never turns an event into a notification retry.
    }
  }

  #markPresenterFailure(): void {
    if (this.#presenterFailed) return;
    this.#presenterFailed = true;
    this.#cancelPendingPresentations();
    try {
      this.#settings.markPresenterFailure();
    } catch {
      // The local guard still prevents a retry loop if settings publication itself is unavailable.
    }
  }

  #clearScope(): void {
    this.#armedConnectionId = null;
    this.#closeAllNotifications();
    this.#pendingActions = [];
    this.#cancelPendingPresentations();
    this.#handledEventIds.clear();
    this.#handledEventOrder = [];
    this.#watermark = "0";
    this.#conversations.clear();
    this.#members.clear();
    this.#memberProjectionHealthy = true;
    this.#blockedConversations.clear();
    this.#projectionHealthy = true;
    this.#renderer = null;
    this.#activity = null;
    this.#session = null;
  }

  #cancelPendingPresentations(): void {
    this.#pendingPresentations = [];
    this.#presentationDrainScheduled = false;
    this.#presentationDrainEpoch += 1;
  }

  #requireActiveSession(): ActiveSession {
    if (this.#session === null || this.#sessionStatus !== "active") {
      throw new Error("Notification session is not active");
    }
    return this.#session;
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("Notification controller is shut down");
  }
}
