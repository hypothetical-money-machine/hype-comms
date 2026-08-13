import type {
  NotificationAction,
  NotificationActionAcknowledgement,
  NotificationActionDrainRequest,
  NotificationActivityView,
  NotificationContext,
} from "@hype-comms/contracts";

import type { DesktopApi, NotificationTransport } from "../../shared/desktop-api";

export interface NotificationActionHandler {
  handleNotificationAction(
    action: NotificationAction,
    context: NotificationContext,
  ): Promise<unknown>;
}

const NOTIFICATION_METHODS = [
  "getNotificationContext",
  "reportNotificationActivity",
  "drainNotificationActions",
  "acknowledgeNotificationAction",
  "onNotificationAction",
  "getNotificationState",
  "setNotificationPreference",
  "refreshNotificationCapability",
  "onNotificationStateChanged",
] as const satisfies readonly (keyof NotificationTransport)[];

const NOTIFICATION_ACTION_DEDUPE_LIMIT = 128;

export function notificationTransportFrom(client: DesktopApi): NotificationTransport | null {
  const candidate: Partial<NotificationTransport> = client;
  return NOTIFICATION_METHODS.every((method) => typeof candidate[method] === "function")
    ? (candidate as NotificationTransport)
    : null;
}

function readyFromContext(
  context: Extract<NotificationContext, { status: "active" }>,
): NotificationActionDrainRequest {
  return {
    version: 1,
    sessionGeneration: context.sessionGeneration,
    rendererSessionGeneration: context.rendererSessionGeneration,
    userId: context.userId,
    workspaceId: context.workspaceId,
  };
}

function sameReadyScope(
  context: Extract<NotificationContext, { status: "active" }>,
  ready: NotificationActionDrainRequest,
): boolean {
  return (
    ready.sessionGeneration === context.sessionGeneration &&
    ready.rendererSessionGeneration === context.rendererSessionGeneration &&
    ready.userId === context.userId &&
    ready.workspaceId === context.workspaceId
  );
}

function actionMatchesContext(
  action: NotificationAction,
  context: Extract<NotificationContext, { status: "active" }>,
): boolean {
  return (
    action.sessionGeneration === context.sessionGeneration &&
    action.userId === context.userId &&
    action.workspaceId === context.workspaceId
  );
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
 * Owns the renderer half of notification readiness. The push listener is installed before the
 * ready/drain request; pushes racing the drain response are held until older drained actions have
 * been queued. Navigation remains serialized and scope checks are repeated by WorkspaceRuntime.
 */
export class NotificationSessionRuntime {
  readonly #transport: NotificationTransport;
  readonly #handler: NotificationActionHandler;
  #context: Extract<NotificationContext, { status: "active" }> | null = null;
  #bindingGeneration = 0;
  #activityRevision = 0;
  #activityTail: Promise<void> = Promise.resolve();
  #actionTail: Promise<void> = Promise.resolve();
  #queuedActionKeys = new Set<string>();
  readonly #handledActions = new Map<string, NotificationAction>();
  readonly #acknowledgedActions = new Map<string, NotificationAction>();
  #stopActionListener: (() => void) | null = null;
  #draining = false;
  #pushesDuringDrain: NotificationAction[] = [];

  constructor(transport: NotificationTransport, handler: NotificationActionHandler) {
    this.#transport = transport;
    this.#handler = handler;
  }

  get context(): NotificationContext | null {
    // Only an established renderer-ready binding is eligible for the idempotent bind path below.
    // The context stays private while the initial action drain is still being accepted.
    return this.#draining ? null : this.#context;
  }

  start(): void {
    this.#stopActionListener ??= this.#transport.onNotificationAction((action) => {
      const context = this.#context;
      if (context === null) return;
      if (this.#draining) {
        this.#pushesDuringDrain.push(action);
        return;
      }
      this.#enqueueAction(action, context);
    });
  }

  async bind(userId: string, workspaceId: string): Promise<NotificationContext | null> {
    const currentContext = this.context;
    if (
      currentContext?.status === "active" &&
      currentContext.userId === userId &&
      currentContext.workspaceId === workspaceId
    ) {
      // Re-entering the same signed-in scope is not a new renderer epoch. In particular, keep the
      // activity revision and its serialized tail: old queued IPC requests carry these unchanged
      // generations and must not be allowed to overtake a reset revision counter.
      return currentContext;
    }

    const bindingGeneration = ++this.#bindingGeneration;
    this.#context = null;
    this.#activityTail = Promise.resolve();
    this.#actionTail = Promise.resolve();
    this.#queuedActionKeys = new Set();
    this.#draining = false;
    this.#pushesDuringDrain = [];

    let context: NotificationContext;
    try {
      context = await this.#transport.getNotificationContext();
    } catch {
      return null;
    }
    if (
      bindingGeneration !== this.#bindingGeneration ||
      context.status !== "active" ||
      context.userId !== userId ||
      context.workspaceId !== workspaceId
    ) {
      return null;
    }

    this.#context = context;
    this.#pruneActionDedupe(context);
    this.#draining = true;
    const ready = readyFromContext(context);
    try {
      const response = await this.#transport.drainNotificationActions(ready);
      if (
        bindingGeneration !== this.#bindingGeneration ||
        this.#context !== context ||
        !sameReadyScope(context, response)
      ) {
        if (bindingGeneration === this.#bindingGeneration && this.#context === context) {
          this.#context = null;
          this.#pushesDuringDrain = [];
          this.#draining = false;
        }
        return null;
      }
      for (const action of response.actions) this.#enqueueAction(action, context);
      for (const action of this.#pushesDuringDrain) this.#enqueueAction(action, context);
      this.#pushesDuringDrain = [];
      this.#draining = false;
      return context;
    } catch {
      if (bindingGeneration === this.#bindingGeneration && this.#context === context) {
        this.#context = null;
        this.#pushesDuringDrain = [];
        this.#draining = false;
      }
      return null;
    }
  }

  invalidate(): void {
    this.#bindingGeneration += 1;
    this.#context = null;
    this.#activityTail = Promise.resolve();
    this.#actionTail = Promise.resolve();
    this.#queuedActionKeys = new Set();
    this.#draining = false;
    this.#pushesDuringDrain = [];
  }

  report(view: NotificationActivityView): Promise<void> {
    const context = this.#context;
    if (context === null) return Promise.resolve();
    const bindingGeneration = this.#bindingGeneration;
    const revision = ++this.#activityRevision;
    const request = {
      ...readyFromContext(context),
      revision,
      view,
    };
    const report = this.#activityTail.then(() => {
      // Invalidation detaches the new binding from this serialized tail. A report that was queued
      // behind older work must not cross that boundary later and replace the new binding's fresh
      // visibility snapshot. Its revision stays consumed so revisions remain lifetime-monotonic.
      if (!this.#isCurrentBinding(context, bindingGeneration)) return;
      return this.#transport.reportNotificationActivity(request);
    });
    this.#activityTail = report.catch(() => undefined);
    return report;
  }

  dispose(): void {
    this.invalidate();
    this.#stopActionListener?.();
    this.#stopActionListener = null;
    this.#handledActions.clear();
    this.#acknowledgedActions.clear();
  }

  #enqueueAction(
    action: NotificationAction,
    context: Extract<NotificationContext, { status: "active" }>,
  ): void {
    const key = notificationActionKey(action);
    const queuedActionKeys = this.#queuedActionKeys;
    if (queuedActionKeys.has(key)) return;
    queuedActionKeys.add(key);
    const bindingGeneration = this.#bindingGeneration;
    const request = this.#actionTail
      .then(() => this.#handleAndAcknowledgeAction(action, context, bindingGeneration))
      .finally(() => queuedActionKeys.delete(key));
    this.#actionTail = request.then(
      () => undefined,
      () => undefined,
    );
  }

  async #handleAndAcknowledgeAction(
    action: NotificationAction,
    context: Extract<NotificationContext, { status: "active" }>,
    bindingGeneration: number,
  ): Promise<void> {
    if (!actionMatchesContext(action, context)) return;
    const key = notificationActionKey(action);
    if (this.#acknowledgedActions.has(key)) return;

    if (!this.#handledActions.has(key)) {
      if (!this.#isCurrentBinding(context, bindingGeneration)) return;
      try {
        await this.#handler.handleNotificationAction(action, context);
      } catch {
        return;
      }
      if (!this.#isCurrentBinding(context, bindingGeneration)) return;
      this.#rememberHandledAction(key, action);
    }

    if (!this.#isCurrentBinding(context, bindingGeneration)) return;
    const acknowledgement: NotificationActionAcknowledgement = {
      ...readyFromContext(context),
      action,
    };
    try {
      await this.#transport.acknowledgeNotificationAction(acknowledgement);
    } catch {
      return;
    }
    if (!this.#isCurrentBinding(context, bindingGeneration)) return;

    this.#handledActions.delete(key);
    this.#acknowledgedActions.delete(key);
    this.#acknowledgedActions.set(key, action);
    while (this.#acknowledgedActions.size > NOTIFICATION_ACTION_DEDUPE_LIMIT) {
      const oldest = this.#acknowledgedActions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#acknowledgedActions.delete(oldest);
    }
  }

  #isCurrentBinding(
    context: Extract<NotificationContext, { status: "active" }>,
    bindingGeneration: number,
  ): boolean {
    return this.#bindingGeneration === bindingGeneration && this.#context === context;
  }

  #pruneActionDedupe(context: Extract<NotificationContext, { status: "active" }>): void {
    for (const [key, action] of this.#handledActions) {
      if (!actionMatchesContext(action, context)) this.#handledActions.delete(key);
    }
    for (const [key, action] of this.#acknowledgedActions) {
      if (!actionMatchesContext(action, context)) this.#acknowledgedActions.delete(key);
    }
  }

  #rememberHandledAction(key: string, action: NotificationAction): void {
    this.#handledActions.delete(key);
    this.#handledActions.set(key, action);
    while (this.#handledActions.size > NOTIFICATION_ACTION_DEDUPE_LIMIT) {
      const oldest = this.#handledActions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#handledActions.delete(oldest);
    }
  }
}
