import type {
  NotificationAction,
  NotificationActionAcknowledgement,
  NotificationActionDrainResponse,
  NotificationActivityUpdate,
  NotificationContext,
  NotificationPreference,
  NotificationState,
} from "@hype-comms/contracts";
import { describe, expect, it, vi } from "vitest";

import type { DesktopApi, NotificationTransport } from "../../shared/desktop-api";
import {
  NotificationSessionRuntime,
  notificationTransportFrom,
  type NotificationActionHandler,
} from "./notification-session-runtime";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000004";

const context: Extract<NotificationContext, { status: "active" }> = {
  version: 1,
  status: "active",
  sessionGeneration: 4,
  rendererSessionGeneration: 7,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

const READY = {
  version: 1,
  sessionGeneration: context.sessionGeneration,
  rendererSessionGeneration: context.rendererSessionGeneration,
  userId: context.userId,
  workspaceId: context.workspaceId,
} as const;

function action(messageId: string): NotificationAction {
  return {
    version: 1,
    type: "open-message",
    sessionGeneration: 4,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    conversationId: CONVERSATION_ID,
    messageId,
    threadRootId: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class FakeTransport implements NotificationTransport {
  readonly listeners = new Set<(action: NotificationAction) => void>();
  readonly activity: NotificationActivityUpdate[] = [];
  readonly activityResults: Promise<void>[] = [];
  readonly acknowledgements: NotificationActionAcknowledgement[] = [];
  readonly acknowledgementResults: (Error | Promise<void>)[] = [];
  contextRequests = 0;
  drainRequests = 0;
  onAcknowledgement: ((acknowledgement: NotificationActionAcknowledgement) => void) | null = null;
  contextResult: Promise<NotificationContext> | NotificationContext = context;
  drainResult: Promise<NotificationActionDrainResponse> | NotificationActionDrainResponse = {
    version: 1,
    sessionGeneration: context.sessionGeneration,
    rendererSessionGeneration: context.rendererSessionGeneration,
    userId: context.userId,
    workspaceId: context.workspaceId,
    actions: [],
  };

  async getNotificationContext(): Promise<NotificationContext> {
    this.contextRequests += 1;
    return this.contextResult;
  }

  async reportNotificationActivity(activity: NotificationActivityUpdate): Promise<void> {
    this.activity.push(activity);
    await this.activityResults.shift();
  }

  async drainNotificationActions(): Promise<NotificationActionDrainResponse> {
    this.drainRequests += 1;
    return this.drainResult;
  }

  async acknowledgeNotificationAction(
    acknowledgement: NotificationActionAcknowledgement,
  ): Promise<void> {
    this.acknowledgements.push(acknowledgement);
    this.onAcknowledgement?.(acknowledgement);
    const result = this.acknowledgementResults.shift();
    if (result instanceof Error) throw result;
    await result;
  }

  onNotificationAction(listener: (value: NotificationAction) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: NotificationAction): void {
    for (const listener of this.listeners) listener(value);
  }

  async getNotificationState(): Promise<NotificationState> {
    throw new Error("Unexpected settings request");
  }

  async setNotificationPreference(preference: NotificationPreference): Promise<NotificationState> {
    void preference;
    throw new Error("Unexpected settings request");
  }

  async refreshNotificationCapability(): Promise<NotificationState> {
    throw new Error("Unexpected settings request");
  }

  onNotificationStateChanged(): () => void {
    return () => undefined;
  }
}

class FakeHandler implements NotificationActionHandler {
  readonly actions: NotificationAction[] = [];

  async handleNotificationAction(value: NotificationAction): Promise<void> {
    this.actions.push(value);
  }
}

async function settle(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) await Promise.resolve();
}

describe("NotificationSessionRuntime", () => {
  it("installs its listener before readiness and orders drained actions before racing pushes", async () => {
    const transport = new FakeTransport();
    const drain = deferred<NotificationActionDrainResponse>();
    transport.drainResult = drain.promise;
    const handler = new FakeHandler();
    const runtime = new NotificationSessionRuntime(transport, handler);
    runtime.start();

    const binding = runtime.bind(USER_ID, WORKSPACE_ID);
    await settle();
    transport.emit(action("10000000-0000-4000-8000-000000000006"));
    const acknowledgementsComplete = deferred<void>();
    transport.onAcknowledgement = () => {
      if (transport.acknowledgements.length === 2) acknowledgementsComplete.resolve();
    };
    drain.resolve({
      version: 1,
      sessionGeneration: context.sessionGeneration,
      rendererSessionGeneration: context.rendererSessionGeneration,
      userId: context.userId,
      workspaceId: context.workspaceId,
      actions: [action("10000000-0000-4000-8000-000000000005")],
    });
    await binding;
    await acknowledgementsComplete.promise;

    expect(handler.actions.map((value) => value.messageId)).toEqual([
      "10000000-0000-4000-8000-000000000005",
      "10000000-0000-4000-8000-000000000006",
    ]);
    expect(transport.acknowledgements.map(({ action: value }) => value.messageId)).toEqual([
      "10000000-0000-4000-8000-000000000005",
      "10000000-0000-4000-8000-000000000006",
    ]);
  });

  it("deduplicates a drain/push race and acknowledges only after handling succeeds", async () => {
    const transport = new FakeTransport();
    const drain = deferred<NotificationActionDrainResponse>();
    transport.drainResult = drain.promise;
    const handled = deferred<void>();
    const handler: NotificationActionHandler = {
      handleNotificationAction: vi.fn(() => handled.promise),
    };
    const runtime = new NotificationSessionRuntime(transport, handler);
    runtime.start();

    const target = action(MESSAGE_ID);
    const binding = runtime.bind(USER_ID, WORKSPACE_ID);
    await settle();
    transport.emit(target);
    drain.resolve({ ...READY, actions: [target] });
    await binding;
    await settle();
    expect(handler.handleNotificationAction).toHaveBeenCalledOnce();
    expect(transport.acknowledgements).toEqual([]);

    handled.resolve();
    await settle();
    expect(handler.handleNotificationAction).toHaveBeenCalledOnce();
    expect(transport.acknowledgements).toEqual([{ ...READY, action: target }]);
  });

  it("retains handled dedupe state and retries only the acknowledgement after IPC failure", async () => {
    const transport = new FakeTransport();
    const target = action(MESSAGE_ID);
    transport.drainResult = { ...READY, actions: [target] };
    transport.acknowledgementResults.push(new Error("renderer-main IPC failed"));
    const handler = new FakeHandler();
    const runtime = new NotificationSessionRuntime(transport, handler);
    runtime.start();

    await runtime.bind(USER_ID, WORKSPACE_ID);
    await settle();
    expect(handler.actions).toEqual([target]);
    expect(transport.acknowledgements).toHaveLength(1);

    transport.emit(target);
    await settle();
    expect(handler.actions).toEqual([target]);
    expect(transport.acknowledgements).toHaveLength(2);
  });

  it("does not acknowledge a handler failure and retries handling on redelivery", async () => {
    const transport = new FakeTransport();
    const target = action(MESSAGE_ID);
    transport.drainResult = { ...READY, actions: [target] };
    const handler: NotificationActionHandler = {
      handleNotificationAction: vi
        .fn<NotificationActionHandler["handleNotificationAction"]>()
        .mockRejectedValueOnce(new Error("navigation failed"))
        .mockResolvedValueOnce("opened"),
    };
    const runtime = new NotificationSessionRuntime(transport, handler);
    runtime.start();

    await runtime.bind(USER_ID, WORKSPACE_ID);
    await settle();
    expect(handler.handleNotificationAction).toHaveBeenCalledOnce();
    expect(transport.acknowledgements).toEqual([]);

    transport.emit(target);
    await settle();
    expect(handler.handleNotificationAction).toHaveBeenCalledTimes(2);
    expect(transport.acknowledgements).toEqual([{ ...READY, action: target }]);
  });

  it("ignores an action whose scope does not match the accepted renderer context", async () => {
    const transport = new FakeTransport();
    const handler = new FakeHandler();
    const runtime = new NotificationSessionRuntime(transport, handler);
    runtime.start();
    await runtime.bind(USER_ID, WORKSPACE_ID);

    transport.emit({
      ...action(MESSAGE_ID),
      workspaceId: "10000000-0000-4000-8000-000000000099",
    });
    await settle();
    expect(handler.actions).toEqual([]);
    expect(transport.acknowledgements).toEqual([]);
  });

  it("bounds handled-but-unacknowledged dedupe state oldest-first", async () => {
    const transport = new FakeTransport();
    const initialHandlingComplete = deferred<void>();
    const handled: NotificationAction[] = [];
    const handler: NotificationActionHandler = {
      async handleNotificationAction(value): Promise<void> {
        handled.push(value);
        if (handled.length === 129) initialHandlingComplete.resolve();
      },
    };
    const runtime = new NotificationSessionRuntime(transport, handler);
    runtime.start();
    await runtime.bind(USER_ID, WORKSPACE_ID);

    const targets = Array.from({ length: 129 }, (_, index) =>
      action(`10000000-0000-4000-8000-${String(1_000 + index).padStart(12, "0")}`),
    );
    transport.acknowledgementResults.push(
      ...targets.map(() => new Error("renderer-main IPC failed")),
    );
    const initialAttemptsComplete = deferred<void>();
    transport.onAcknowledgement = () => {
      if (transport.acknowledgements.length === targets.length) initialAttemptsComplete.resolve();
    };
    for (const target of targets) transport.emit(target);
    await initialHandlingComplete.promise;
    await initialAttemptsComplete.promise;
    await settle();
    expect(handled).toHaveLength(129);
    expect(transport.acknowledgements).toHaveLength(129);

    const retriesComplete = deferred<void>();
    transport.onAcknowledgement = () => {
      if (transport.acknowledgements.length === 131) retriesComplete.resolve();
    };
    transport.emit(targets[0]!);
    transport.emit(targets.at(-1)!);
    await retriesComplete.promise;
    expect(handled).toHaveLength(130);
    expect(handled.at(-1)).toEqual(targets[0]);
    expect(transport.acknowledgements).toHaveLength(131);
  });

  it("lets a replacement scope bypass a deferred old handler without stale completion", async () => {
    const transport = new FakeTransport();
    const oldTarget = action("10000000-0000-4000-8000-000000000020");
    transport.drainResult = { ...READY, actions: [oldTarget] };
    const oldHandling = deferred<void>();
    const handled: NotificationAction[] = [];
    const handler: NotificationActionHandler = {
      async handleNotificationAction(value): Promise<void> {
        handled.push(value);
        if (value.messageId === oldTarget.messageId) await oldHandling.promise;
      },
    };
    const runtime = new NotificationSessionRuntime(transport, handler);
    runtime.start();
    await runtime.bind(USER_ID, WORKSPACE_ID);
    await settle();
    expect(handled).toEqual([oldTarget]);

    runtime.invalidate();
    const replacementContext = {
      ...context,
      sessionGeneration: context.sessionGeneration + 1,
      rendererSessionGeneration: context.rendererSessionGeneration + 1,
    } as const;
    const replacementReady = {
      ...READY,
      sessionGeneration: replacementContext.sessionGeneration,
      rendererSessionGeneration: replacementContext.rendererSessionGeneration,
    } as const;
    const replacementTarget = {
      ...action("10000000-0000-4000-8000-000000000021"),
      sessionGeneration: replacementContext.sessionGeneration,
    };
    transport.contextResult = replacementContext;
    transport.drainResult = { ...replacementReady, actions: [replacementTarget] };
    await runtime.bind(USER_ID, WORKSPACE_ID);
    await settle();
    expect(handled).toEqual([oldTarget, replacementTarget]);
    expect(transport.acknowledgements).toEqual([
      { ...replacementReady, action: replacementTarget },
    ]);

    oldHandling.resolve();
    await settle();
    expect(transport.acknowledgements).toEqual([
      { ...replacementReady, action: replacementTarget },
    ]);
  });

  it("re-drains an in-flight action after invalidation without acknowledging the old handler", async () => {
    const transport = new FakeTransport();
    const target = action(MESSAGE_ID);
    transport.drainResult = { ...READY, actions: [target] };
    const oldHandling = deferred<void>();
    const opened: NotificationAction[] = [];
    let handlingAttempts = 0;
    const handler: NotificationActionHandler = {
      async handleNotificationAction(value): Promise<void> {
        handlingAttempts += 1;
        if (handlingAttempts === 1) {
          await oldHandling.promise;
          return;
        }
        opened.push(value);
      },
    };
    const runtime = new NotificationSessionRuntime(transport, handler);
    runtime.start();
    await runtime.bind(USER_ID, WORKSPACE_ID);
    await settle();
    expect(handlingAttempts).toBe(1);
    expect(transport.acknowledgements).toEqual([]);

    runtime.invalidate();
    await runtime.bind(USER_ID, WORKSPACE_ID);
    await settle();
    expect(handlingAttempts).toBe(2);
    expect(opened).toEqual([target]);
    expect(transport.acknowledgements).toEqual([{ ...READY, action: target }]);

    oldHandling.resolve();
    await settle();
    expect(opened).toEqual([target]);
    expect(transport.acknowledgements).toEqual([{ ...READY, action: target }]);
  });

  it("discards a context response retired by session replacement", async () => {
    const transport = new FakeTransport();
    const pending = deferred<NotificationContext>();
    transport.contextResult = pending.promise;
    const runtime = new NotificationSessionRuntime(transport, new FakeHandler());
    runtime.start();

    const binding = runtime.bind(USER_ID, WORKSPACE_ID);
    runtime.invalidate();
    pending.resolve(context);

    await expect(binding).resolves.toBeNull();
    expect(runtime.context).toBeNull();
  });

  it("ignores an old action throughout a deferred replacement-scope startup", async () => {
    const transport = new FakeTransport();
    const handler = new FakeHandler();
    const runtime = new NotificationSessionRuntime(transport, handler);
    runtime.start();
    await runtime.bind(USER_ID, WORKSPACE_ID);

    // App invalidates synchronously before awaiting the replacement WorkspaceRuntime.start().
    runtime.invalidate();
    const replacementContext = deferred<NotificationContext>();
    transport.contextResult = replacementContext.promise;
    const replacementBinding = runtime.bind(USER_ID, WORKSPACE_ID);
    transport.emit(action(MESSAGE_ID));
    await settle();
    expect(handler.actions).toEqual([]);

    replacementContext.resolve({
      ...context,
      sessionGeneration: context.sessionGeneration + 1,
      rendererSessionGeneration: context.rendererSessionGeneration + 1,
    });
    await expect(replacementBinding).resolves.toBeNull();
    expect(handler.actions).toEqual([]);
  });

  it("serializes monotonic activity revisions for the accepted context", async () => {
    const transport = new FakeTransport();
    const runtime = new NotificationSessionRuntime(transport, new FakeHandler());
    runtime.start();
    await runtime.bind(USER_ID, WORKSPACE_ID);

    await Promise.all([
      runtime.report({ pane: "none" }),
      runtime.report({ pane: "tasks", conversationId: CONVERSATION_ID }),
    ]);

    expect(transport.activity.map((value) => value.revision)).toEqual([1, 2]);
    expect(transport.activity[1]?.view).toEqual({
      pane: "tasks",
      conversationId: CONVERSATION_ID,
    });
  });

  it("keeps a same-scope repeat bind in the existing activity epoch", async () => {
    const transport = new FakeTransport();
    const firstReport = deferred<void>();
    transport.activityResults.push(firstReport.promise);
    const runtime = new NotificationSessionRuntime(transport, new FakeHandler());
    runtime.start();
    await runtime.bind(USER_ID, WORKSPACE_ID);

    const reportingFirst = runtime.report({ pane: "none" });
    await settle();
    expect(transport.activity.map((value) => value.revision)).toEqual([1]);

    await expect(runtime.bind(USER_ID, WORKSPACE_ID)).resolves.toBe(context);
    expect(transport.contextRequests).toBe(1);
    expect(transport.drainRequests).toBe(1);

    const reportingSecond = runtime.report({
      pane: "tasks",
      conversationId: CONVERSATION_ID,
    });
    await settle();
    expect(transport.activity.map((value) => value.revision)).toEqual([1]);

    firstReport.resolve();
    await Promise.all([reportingFirst, reportingSecond]);
    expect(transport.activity.map((value) => value.revision)).toEqual([1, 2]);
    expect(transport.activity[1]?.view).toEqual({
      pane: "tasks",
      conversationId: CONVERSATION_ID,
    });
  });

  it("keeps revisions monotonic and drops queued activity from a retired binding", async () => {
    const transport = new FakeTransport();
    const oldReport = deferred<void>();
    transport.activityResults.push(oldReport.promise);
    const runtime = new NotificationSessionRuntime(transport, new FakeHandler());
    runtime.start();
    await runtime.bind(USER_ID, WORKSPACE_ID);

    const reportingOld = runtime.report({ pane: "none" });
    await settle();
    expect(transport.activity).toHaveLength(1);
    const reportingQueuedOld = runtime.report({
      pane: "chat",
      conversationId: CONVERSATION_ID,
      timelineAtLiveTail: true,
      thread: null,
    });
    runtime.invalidate();

    const replacementContext = {
      ...context,
      sessionGeneration: context.sessionGeneration + 1,
    } as const;
    transport.contextResult = replacementContext;
    transport.drainResult = {
      version: 1,
      sessionGeneration: replacementContext.sessionGeneration,
      rendererSessionGeneration: replacementContext.rendererSessionGeneration,
      userId: replacementContext.userId,
      workspaceId: replacementContext.workspaceId,
      actions: [],
    };
    await runtime.bind(USER_ID, WORKSPACE_ID);
    expect(transport.contextRequests).toBe(2);
    expect(transport.drainRequests).toBe(2);
    await expect(
      runtime.report({ pane: "tasks", conversationId: CONVERSATION_ID }),
    ).resolves.toBeUndefined();
    expect(transport.activity).toHaveLength(2);
    expect(transport.activity[1]?.revision).toBe(3);
    expect(transport.activity[1]?.sessionGeneration).toBe(replacementContext.sessionGeneration);
    expect(transport.activity[1]?.rendererSessionGeneration).toBe(
      context.rendererSessionGeneration,
    );

    oldReport.resolve();
    await expect(Promise.all([reportingOld, reportingQueuedOld])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(transport.activity.map((activity) => activity.revision)).toEqual([1, 3]);
  });

  it("rejects mismatched context scope and tears down its push listener", async () => {
    const transport = new FakeTransport();
    const handler = new FakeHandler();
    const runtime = new NotificationSessionRuntime(transport, handler);
    runtime.start();

    await expect(runtime.bind(USER_ID, "10000000-0000-4000-8000-000000000099")).resolves.toBeNull();
    transport.emit(action(MESSAGE_ID));
    await settle();
    expect(handler.actions).toEqual([]);

    runtime.dispose();
    expect(transport.listeners.size).toBe(0);
  });

  it("requires the complete notification transport surface", () => {
    expect(notificationTransportFrom({} as DesktopApi)).toBeNull();
    const transport = new FakeTransport();
    expect(notificationTransportFrom(transport as unknown as DesktopApi)).toBe(transport);
    vi.restoreAllMocks();
  });
});
