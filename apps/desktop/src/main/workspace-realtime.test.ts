import { EventEmitter } from "node:events";

import type { ProductRealtimeEvent } from "@hmm-chat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import {
  WORKSPACE_REALTIME_MAX_PAYLOAD_BYTES,
  WORKSPACE_REALTIME_PENDING_REPLAY_BYTE_LIMIT,
  WORKSPACE_REALTIME_PENDING_REPLAY_EVENT_LIMIT,
  WorkspaceRealtime,
  type RealtimeConnectionState,
  type WorkspaceRealtimeScope,
} from "./workspace-realtime";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONVERSATION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CONVERSATION_B = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const MEMBER_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const NOW = "2026-08-10T12:00:00.000Z";

const SCOPE_A: WorkspaceRealtimeScope = { userId: USER_A, workspaceId: WORKSPACE_A };
const SCOPE_B: WorkspaceRealtimeScope = { userId: USER_B, workspaceId: WORKSPACE_B };

class FakeSocket extends EventEmitter {
  readonly close = vi.fn((code?: number, reason?: string): void => {
    void code;
    void reason;
  });
  readonly terminate = vi.fn((): void => undefined);

  open(): void {
    this.emit("open");
  }

  message(input: unknown): void {
    const data = typeof input === "string" ? input : JSON.stringify(input);
    this.emit("message", Buffer.from(data));
  }

  fail(error = new Error("socket failed")): void {
    this.emit("error", error);
  }

  closed(): void {
    this.emit("close");
  }
}

function ticketResponse(ticket = "t".repeat(32)): { ticket: string; expiresAt: string } {
  return { ticket, expiresAt: "2026-08-10T12:01:00.000Z" };
}

function connectedEvent(options?: {
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly connectionId?: string;
  readonly workspaceSequence?: string;
}): ProductRealtimeEvent {
  return {
    version: 1,
    id: EVENT_ID,
    type: "system.connected",
    occurredAt: NOW,
    workspaceId: options?.workspaceId ?? WORKSPACE_A,
    conversationId: null,
    workspaceSequence: options?.workspaceSequence ?? "10",
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: {
      connectionId: options?.connectionId ?? CONNECTION_A,
      userId: options?.userId ?? USER_A,
    },
  };
}

function membershipEvent(options?: {
  readonly workspaceId?: string;
  readonly workspaceSequence?: string;
}): ProductRealtimeEvent {
  return {
    version: 1,
    id: EVENT_ID,
    type: "channel.membership_changed",
    occurredAt: NOW,
    workspaceId: options?.workspaceId ?? WORKSPACE_A,
    conversationId: CONVERSATION_ID,
    workspaceSequence: options?.workspaceSequence ?? "9",
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { memberId: MEMBER_ID, action: "updated" },
  };
}

function messageEvent(
  body = "private-realtime-canary",
): Extract<ProductRealtimeEvent, { type: "message.created" }> {
  return {
    version: 1,
    id: EVENT_ID,
    type: "message.created",
    occurredAt: NOW,
    workspaceId: WORKSPACE_A,
    conversationId: CONVERSATION_ID,
    workspaceSequence: "9",
    conversationSequence: "1",
    entityVersion: 1,
    delivery: "at_least_once",
    payload: {
      message: {
        id: MEMBER_ID,
        conversationId: CONVERSATION_ID,
        conversationSequence: "1",
        version: 1,
        clientMessageId: CONNECTION_B,
        authorId: USER_B,
        threadRootId: null,
        body,
        bodyFormat: "hmm_markdown_v1",
        editedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      mentionedUserIds: [],
    },
  };
}

function resyncRequiredEvent(): ProductRealtimeEvent {
  return {
    version: 1,
    id: EVENT_ID,
    type: "system.resync_required",
    occurredAt: NOW,
    workspaceId: WORKSPACE_A,
    conversationId: null,
    workspaceSequence: "8",
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { reason: "cursor_expired" },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (reason) => rejectPromise?.(reason),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(options?: {
  readonly ticket?: () => Promise<{ ticket: string; expiresAt: string }>;
  readonly onEvent?: (event: ProductRealtimeEvent) => boolean;
  readonly onWindowlessEvent?: (event: ProductRealtimeEvent) => void;
  readonly onState?: (state: RealtimeConnectionState) => void;
}) {
  const sockets: FakeSocket[] = [];
  const urls: URL[] = [];
  const origins: string[] = [];
  const maxPayloads: number[] = [];
  const states: RealtimeConnectionState[] = [];
  const ticket = vi.fn<() => Promise<{ ticket: string; expiresAt: string }>>(
    options?.ticket ?? (async () => ticketResponse()),
  );
  const onEvent = vi.fn<(event: ProductRealtimeEvent) => boolean>(options?.onEvent ?? (() => true));
  const onWindowlessEvent = vi.fn<(event: ProductRealtimeEvent) => void>(
    options?.onWindowlessEvent ?? (() => undefined),
  );
  const createSocket = vi.fn(
    (url: URL, socketOptions: { readonly origin: string; readonly maxPayload: number }) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      urls.push(url);
      origins.push(socketOptions.origin);
      maxPayloads.push(socketOptions.maxPayload);
      return socket as unknown as WebSocket;
    },
  );
  const realtime = new WorkspaceRealtime({
    apiOrigin: "http://127.0.0.1:3000",
    rendererOrigin: "http://127.0.0.1:5173",
    transport: { ticket },
    onEvent,
    onWindowlessEvent,
    onState: (state) => {
      states.push(state);
      options?.onState?.(state);
    },
    createSocket,
  });
  return {
    realtime,
    ticket,
    createSocket,
    sockets,
    onEvent,
    onWindowlessEvent,
    states,
    urls,
    origins,
    maxPayloads,
  };
}

describe("WorkspaceRealtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses the acknowledged cursor and reaches live only after a scope-matching handshake", async () => {
    const harness = createHarness();

    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();

    expect(harness.states).toEqual(["connecting"]);
    expect(harness.ticket).toHaveBeenCalledTimes(1);
    expect(harness.urls[0]?.protocol).toBe("ws:");
    expect(harness.urls[0]?.searchParams.get("ticket")).toBe("t".repeat(32));
    expect(harness.urls[0]?.searchParams.get("after")).toBe("8");
    expect(harness.origins).toEqual(["http://127.0.0.1:5173"]);
    expect(harness.maxPayloads).toEqual([WORKSPACE_REALTIME_MAX_PAYLOAD_BYTES]);

    const socket = harness.sockets[0];
    expect(socket).toBeDefined();
    socket?.open();
    socket?.message(membershipEvent());
    expect(harness.states).toEqual(["connecting"]);
    expect(harness.onEvent).not.toHaveBeenCalled();

    socket?.message(connectedEvent());
    expect(harness.states).toEqual(["connecting", "live"]);
    expect(harness.onEvent).toHaveBeenCalledTimes(2);
    expect(socket?.close).not.toHaveBeenCalled();

    harness.realtime.stop();
  });

  it("replaces an active generation when the authoritative scope changes", async () => {
    const harness = createHarness();

    harness.realtime.start("90", SCOPE_A);
    await flushMicrotasks();
    const staleSocket = harness.sockets[0];
    harness.realtime.acknowledge("100");

    harness.realtime.start("3", SCOPE_B);
    await flushMicrotasks();

    expect(staleSocket?.close).toHaveBeenCalledTimes(1);
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(harness.urls[1]?.searchParams.get("after")).toBe("3");
    expect(harness.states).toEqual(["connecting", "connecting"]);

    staleSocket?.open();
    staleSocket?.message(connectedEvent());
    staleSocket?.fail();
    staleSocket?.closed();
    expect(harness.onEvent).not.toHaveBeenCalled();
    expect(harness.states).toEqual(["connecting", "connecting"]);
    expect(vi.getTimerCount()).toBe(0);

    harness.sockets[1]?.message(
      connectedEvent({
        workspaceId: WORKSPACE_B,
        userId: USER_B,
        connectionId: CONNECTION_B,
        workspaceSequence: "3",
      }),
    );
    expect(harness.states).toEqual(["connecting", "connecting", "live"]);
    expect(harness.onEvent).toHaveBeenCalledTimes(1);

    harness.realtime.stop();
  });

  it("makes a superseded ticket request inert across stop and restart", async () => {
    const first = deferred<{ ticket: string; expiresAt: string }>();
    const second = deferred<{ ticket: string; expiresAt: string }>();
    let request = 0;
    const harness = createHarness({
      ticket: () => (request++ === 0 ? first.promise : second.promise),
    });

    harness.realtime.start("4", SCOPE_A);
    harness.realtime.stop();
    harness.realtime.start("7", SCOPE_B);
    expect(harness.ticket).toHaveBeenCalledTimes(2);

    first.resolve(ticketResponse("s".repeat(32)));
    await flushMicrotasks();
    expect(harness.createSocket).not.toHaveBeenCalled();

    second.resolve(ticketResponse("u".repeat(32)));
    await flushMicrotasks();
    expect(harness.createSocket).toHaveBeenCalledTimes(1);
    expect(harness.urls[0]?.searchParams.get("ticket")).toBe("u".repeat(32));
    expect(harness.urls[0]?.searchParams.get("after")).toBe("7");

    harness.realtime.stop();
  });

  it("does not report or reconnect a rejected ticket from a stopped generation", async () => {
    const pending = deferred<{ ticket: string; expiresAt: string }>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness({ ticket: () => pending.promise });

    harness.realtime.start("4", SCOPE_A);
    harness.realtime.stop();
    pending.reject(new Error("stale ticket failure"));
    await flushMicrotasks();

    expect(consoleError).not.toHaveBeenCalled();
    expect(harness.createSocket).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes a reconnect timer inert after a new scope generation starts", async () => {
    const harness = createHarness();
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    harness.realtime.start("5", SCOPE_A);
    await flushMicrotasks();
    harness.sockets[0]?.closed();
    expect(harness.states).toEqual(["connecting", "reconnecting"]);
    expect(vi.getTimerCount()).toBe(1);

    harness.realtime.start("6", SCOPE_B);
    await flushMicrotasks();
    expect(harness.ticket).toHaveBeenCalledTimes(2);

    await vi.runOnlyPendingTimersAsync();
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(harness.states).toEqual(["connecting", "reconnecting", "connecting"]);

    clearTimeout.mockRestore();
    harness.realtime.stop();
  });

  it("does not arm a reconnect timer after a state callback stops the generation", async () => {
    const target: { realtime?: WorkspaceRealtime } = {};
    const harness = createHarness({
      onState: (state) => {
        if (state === "reconnecting") target.realtime?.stop();
      },
    });
    target.realtime = harness.realtime;

    harness.realtime.start("5", SCOPE_A);
    await flushMicrotasks();
    harness.sockets[0]?.closed();

    expect(harness.states).toEqual(["connecting", "reconnecting", "offline"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.ticket).toHaveBeenCalledTimes(1);
  });

  it("keeps the highest acknowledged cursor when start repeats for the same scope", async () => {
    const harness = createHarness();

    harness.realtime.start("5", SCOPE_A);
    await flushMicrotasks();
    harness.realtime.start("9", { ...SCOPE_A });
    harness.realtime.start("2", { ...SCOPE_A });
    expect(harness.ticket).toHaveBeenCalledTimes(1);

    harness.sockets[0]?.closed();
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(harness.urls[1]?.searchParams.get("after")).toBe("9");

    harness.realtime.stop();
  });

  it("observes windowless events without renderer delivery, buffering, or cursor progress", async () => {
    const harness = createHarness({ onEvent: () => false });

    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();
    const windowedSocket = harness.sockets[0];
    windowedSocket?.message(connectedEvent({ workspaceSequence: "8" }));
    expect(windowedSocket?.close).toHaveBeenCalledTimes(1);

    // A failed renderer delivery pauses the first generation. Windowless mode reconnects from the
    // same last acknowledged cursor and treats the callback only as a notification observer.
    harness.realtime.enterWindowless(SCOPE_A);
    await flushMicrotasks();
    const windowlessSocket = harness.sockets[1];
    expect(harness.urls[1]?.searchParams.get("after")).toBe("8");

    windowlessSocket?.message(connectedEvent({ workspaceSequence: "8" }));
    windowlessSocket?.message(messageEvent());

    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    expect(harness.onWindowlessEvent).toHaveBeenCalledTimes(2);
    expect(windowlessSocket?.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // Renderer readiness follows HTTP catch-up and opens a new epoch from the durable replica
    // cursor. The windowless message was never claimed as UI progress or buffered for delivery.
    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();
    expect(windowlessSocket?.close).toHaveBeenCalledTimes(1);
    expect(harness.urls[2]?.searchParams.get("after")).toBe("8");
    harness.sockets[2]?.message(connectedEvent({ workspaceSequence: "8" }));
    expect(harness.onEvent).toHaveBeenCalledTimes(2);
    expect(harness.onWindowlessEvent).toHaveBeenCalledTimes(2);

    harness.realtime.stop();
  });

  it("resumes windowless transport from the highest renderer acknowledgement", async () => {
    const harness = createHarness();

    harness.realtime.start("5", SCOPE_A);
    await flushMicrotasks();
    harness.realtime.acknowledge("7");
    harness.realtime.stop();

    harness.realtime.enterWindowless(SCOPE_A);
    await flushMicrotasks();

    expect(harness.urls[1]?.searchParams.get("after")).toBe("7");
    harness.realtime.stop();
  });

  it("keeps a windowless notification callback failure outside transport health", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness({
      onWindowlessEvent: () => {
        throw new Error("private-windowless-canary");
      },
    });

    harness.realtime.enterWindowless(SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    socket?.message(connectedEvent());
    socket?.message(messageEvent());

    expect(socket?.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.onEvent).not.toHaveBeenCalled();
    expect(harness.onWindowlessEvent).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith("Windowless workspace realtime observation failed");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private-windowless-canary");

    harness.realtime.stop();
  });

  it("latches a windowless resync demand until renderer recovery supplies a newer cursor", async () => {
    const harness = createHarness();

    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    socket?.message(connectedEvent({ workspaceSequence: "8" }));
    harness.realtime.enterWindowless(SCOPE_A);

    const recovery = resyncRequiredEvent();
    socket?.message(recovery);
    expect(harness.onWindowlessEvent).toHaveBeenCalledOnce();
    expect(harness.onWindowlessEvent).toHaveBeenCalledWith(recovery);
    expect(socket?.close).toHaveBeenCalledTimes(1);
    expect(harness.states).toEqual(["connecting", "live", "offline"]);

    socket?.closed();
    await vi.runOnlyPendingTimersAsync();
    expect(harness.ticket).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // The recreated renderer receives the retained body-free control, but delivery alone cannot
    // reopen the cursor-expired generation. Its resync flow stops transport, commits a newer
    // snapshot, and starts once from that new durable cursor.
    expect(harness.realtime.start("8", SCOPE_A)).toBe(true);
    expect(harness.onEvent).toHaveBeenLastCalledWith(recovery);
    expect(harness.ticket).toHaveBeenCalledTimes(1);
    harness.realtime.stop();
    harness.realtime.start("9", SCOPE_A);
    await flushMicrotasks();

    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(harness.urls[1]?.searchParams.get("after")).toBe("9");
    harness.realtime.resetSession();
  });

  it("rejects a replay event from another workspace before delivery", async () => {
    const harness = createHarness();

    harness.realtime.start("12", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    socket?.message(membershipEvent({ workspaceId: WORKSPACE_B }));

    expect(harness.onEvent).not.toHaveBeenCalled();
    expect(socket?.close).toHaveBeenCalledWith(1002, "Invalid realtime event");
    expect(harness.states).toEqual(["connecting", "reconnecting"]);

    harness.realtime.stop();
  });

  it.each([
    ["user", connectedEvent({ userId: USER_B })],
    ["workspace", connectedEvent({ workspaceId: WORKSPACE_B })],
  ])("rejects a system.connected event for the wrong %s", async (_field, frame) => {
    const harness = createHarness();

    harness.realtime.start("12", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    socket?.message(membershipEvent());
    socket?.message(frame);

    expect(harness.onEvent).not.toHaveBeenCalled();
    expect(socket?.close).toHaveBeenCalledWith(1002, "Invalid realtime event");
    expect(harness.states).toEqual(["connecting", "reconnecting"]);

    harness.realtime.stop();
  });

  it("delivers a pre-handshake resync requirement so an expired cursor can recover", async () => {
    const harness = createHarness();

    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();
    harness.sockets[0]?.message(resyncRequiredEvent());

    expect(harness.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "system.resync_required" }),
    );
    expect(harness.states).toEqual(["connecting"]);

    harness.realtime.stop();
  });

  it("binds one system.connected connection ID and rejects a second handshake", async () => {
    const harness = createHarness();

    harness.realtime.start("10", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    socket?.message(connectedEvent());
    socket?.message(connectedEvent({ connectionId: CONNECTION_B }));

    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    expect(socket?.close).toHaveBeenCalledWith(1002, "Invalid realtime event");
    expect(harness.states).toEqual(["connecting", "live", "reconnecting"]);

    harness.realtime.stop();
  });

  it.each([
    ["invalid JSON", "not-json-private-canary"],
    [
      "an unknown event type",
      {
        version: 1,
        id: EVENT_ID,
        type: "message.future",
        occurredAt: NOW,
        workspaceId: WORKSPACE_A,
        conversationId: CONVERSATION_ID,
        workspaceSequence: "11",
        conversationSequence: "1",
        entityVersion: 1,
        delivery: "at_least_once",
        payload: { privateCanary: "must-not-be-logged" },
      },
    ],
    ["an unknown field", { ...membershipEvent(), privateCanary: "must-not-be-logged" }],
  ])("fails closed on %s without logging the frame", async (_name, frame) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness();

    harness.realtime.start("10", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    socket?.message(frame);

    expect(harness.onEvent).not.toHaveBeenCalled();
    expect(socket?.close).toHaveBeenCalledWith(1002, "Invalid realtime event");
    expect(harness.states).toEqual(["connecting", "reconnecting"]);
    expect(consoleError).toHaveBeenCalledWith("Rejected an invalid realtime event");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private-canary");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("must-not-be-logged");

    harness.realtime.stop();
  });

  it.each([
    [
      "a cross-conversation message payload",
      {
        ...messageEvent(),
        payload: {
          ...messageEvent().payload,
          message: { ...messageEvent().payload.message, conversationId: CONVERSATION_B },
        },
      },
    ],
    [
      "a mismatched message sequence",
      {
        ...messageEvent(),
        payload: {
          ...messageEvent().payload,
          message: { ...messageEvent().payload.message, conversationSequence: "2" },
        },
      },
    ],
    ["a mismatched message version", { ...messageEvent(), entityVersion: 2 }],
  ])("closes with 1002 before delivering %s", async (_name, frame) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness();

    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    socket?.message(frame);

    expect(harness.onEvent).not.toHaveBeenCalled();
    expect(socket?.close).toHaveBeenCalledWith(1002, "Invalid realtime event");
    expect(harness.states).toEqual(["connecting", "reconnecting"]);
    expect(consoleError).toHaveBeenCalledWith("Rejected an invalid realtime event");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private-realtime-canary");

    harness.realtime.stop();
  });

  it("bounds replay count and waits for an authoritative restart instead of reconnecting", async () => {
    const harness = createHarness();

    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    for (let index = 0; index < WORKSPACE_REALTIME_PENDING_REPLAY_EVENT_LIMIT; index += 1) {
      socket?.message(membershipEvent());
    }
    expect(harness.onEvent).not.toHaveBeenCalled();

    socket?.message(membershipEvent());
    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    expect(harness.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system.resync_required",
        workspaceSequence: "8",
        payload: { reason: "client_replay_overflow" },
      }),
    );
    expect(socket?.close).toHaveBeenCalledWith(1009, "Realtime replay buffer exceeded");
    expect(harness.states).toEqual(["connecting", "offline"]);

    socket?.message(membershipEvent());
    socket?.closed();
    await vi.runOnlyPendingTimersAsync();
    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    expect(harness.ticket).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    harness.realtime.start("5000", SCOPE_A);
    await flushMicrotasks();
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(harness.urls[1]?.searchParams.get("after")).toBe("5000");

    harness.realtime.stop();
  });

  it("retains replay-overflow recovery while the renderer is unavailable and redelivers on start", async () => {
    const harness = createHarness();

    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();
    harness.realtime.rendererUnavailable();
    const socket = harness.sockets[0];
    for (let index = 0; index <= WORKSPACE_REALTIME_PENDING_REPLAY_EVENT_LIMIT; index += 1) {
      socket?.message(membershipEvent());
    }

    expect(harness.onEvent).not.toHaveBeenCalled();
    expect(harness.states).toEqual(["connecting", "offline"]);
    expect(harness.ticket).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    expect(harness.realtime.start("8", SCOPE_A)).toBe(true);
    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    expect(harness.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system.resync_required",
        workspaceSequence: "8",
        payload: { reason: "client_replay_overflow" },
      }),
    );
    // Delivery alone must not reconnect from the cursor that overflowed. The renderer first stops,
    // performs authoritative HTTP recovery, and then explicitly starts from its repaired cursor.
    expect(harness.ticket).toHaveBeenCalledTimes(1);
    harness.realtime.stop();
    harness.realtime.start("5000", SCOPE_A);
    await flushMicrotasks();
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(harness.urls[1]?.searchParams.get("after")).toBe("5000");

    harness.realtime.stop();
  });

  it("retains a recovery latch after failed delivery and redelivers the same body-free control", async () => {
    let rendererAcceptsDelivery = false;
    const harness = createHarness({
      onEvent: () => rendererAcceptsDelivery,
    });
    const canaryBody = "private-retained-replay-canary".padEnd(4_000, "x");
    const frame = messageEvent(canaryBody);
    const acceptedFrames = Math.floor(
      WORKSPACE_REALTIME_PENDING_REPLAY_BYTE_LIMIT / Buffer.byteLength(JSON.stringify(frame)),
    );

    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    for (let index = 0; index <= acceptedFrames; index += 1) socket?.message(frame);

    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    const firstRecovery = harness.onEvent.mock.calls[0]?.[0];
    expect(firstRecovery).toMatchObject({
      type: "system.resync_required",
      payload: { reason: "client_replay_overflow" },
    });
    expect(harness.realtime.start("8", SCOPE_A)).toBe(false);
    expect(harness.onEvent).toHaveBeenCalledTimes(2);
    expect(harness.onEvent.mock.calls[1]?.[0]).toBe(firstRecovery);

    rendererAcceptsDelivery = true;
    expect(harness.realtime.start("8", SCOPE_A)).toBe(true);
    expect(harness.onEvent).toHaveBeenCalledTimes(3);
    expect(harness.onEvent.mock.calls[2]?.[0]).toBe(firstRecovery);
    expect(JSON.stringify(harness.onEvent.mock.calls)).not.toContain(
      "private-retained-replay-canary",
    );
    expect(harness.ticket).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // A renderer-owned stop during recovery is not sign-out. The same/older durable cursor must
    // still receive the retained control and may not reopen the overflowing socket generation.
    harness.realtime.stop();
    expect(harness.realtime.start("8", SCOPE_A)).toBe(true);
    expect(harness.onEvent).toHaveBeenCalledTimes(4);
    expect(harness.ticket).toHaveBeenCalledTimes(1);

    harness.realtime.start("9", SCOPE_A);
    await flushMicrotasks();
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(harness.urls[1]?.searchParams.get("after")).toBe("9");

    harness.realtime.resetSession();
  });

  it("purges a retained recovery latch on scope replacement and definitive session reset", async () => {
    const harness = createHarness({ onEvent: () => false });

    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();
    for (let index = 0; index <= WORKSPACE_REALTIME_PENDING_REPLAY_EVENT_LIMIT; index += 1) {
      harness.sockets[0]?.message(membershipEvent());
    }
    expect(harness.onEvent).toHaveBeenCalledTimes(1);

    harness.realtime.start("3", SCOPE_B);
    await flushMicrotasks();
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(harness.urls[1]?.searchParams.get("after")).toBe("3");
    expect(harness.onEvent).toHaveBeenCalledTimes(1);

    for (let index = 0; index <= WORKSPACE_REALTIME_PENDING_REPLAY_EVENT_LIMIT; index += 1) {
      harness.sockets[1]?.message(membershipEvent({ workspaceId: WORKSPACE_B }));
    }
    expect(harness.onEvent).toHaveBeenCalledTimes(2);

    harness.realtime.resetSession();
    harness.realtime.start("3", SCOPE_B);
    await flushMicrotasks();
    expect(harness.ticket).toHaveBeenCalledTimes(3);
    expect(harness.urls[2]?.searchParams.get("after")).toBe("3");
    expect(harness.onEvent).toHaveBeenCalledTimes(2);

    harness.realtime.stop();
  });

  it("bounds replay bytes and keeps buffered message content out of recovery and logs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness();
    const canaryBody = "private-byte-canary".padEnd(4_000, "x");
    const frame = messageEvent(canaryBody);
    const frameBytes = Buffer.byteLength(JSON.stringify(frame));
    const acceptedFrames = Math.floor(WORKSPACE_REALTIME_PENDING_REPLAY_BYTE_LIMIT / frameBytes);
    expect(frameBytes).toBeLessThan(WORKSPACE_REALTIME_MAX_PAYLOAD_BYTES);
    expect(acceptedFrames).toBeLessThan(WORKSPACE_REALTIME_PENDING_REPLAY_EVENT_LIMIT);

    harness.realtime.start("8", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    for (let index = 0; index < acceptedFrames; index += 1) socket?.message(frame);
    expect(harness.onEvent).not.toHaveBeenCalled();

    socket?.message(frame);
    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    expect(harness.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system.resync_required",
        payload: { reason: "client_replay_overflow" },
      }),
    );
    expect(JSON.stringify(harness.onEvent.mock.calls)).not.toContain("private-byte-canary");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private-byte-canary");
    expect(consoleError).toHaveBeenCalledWith(
      "Workspace realtime replay exceeded its pre-live buffer",
    );
    expect(harness.states).toEqual(["connecting", "offline"]);
    expect(vi.getTimerCount()).toBe(0);

    harness.realtime.stop();
  });

  it("reconnects from the last acknowledged cursor after rejecting a frame", async () => {
    const harness = createHarness();

    harness.realtime.start("10", SCOPE_A);
    await flushMicrotasks();
    harness.sockets[0]?.message(membershipEvent({ workspaceSequence: "11" }));
    harness.realtime.acknowledge("12");
    harness.realtime.acknowledge("7");
    harness.sockets[0]?.message("invalid");

    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();
    expect(harness.urls[1]?.searchParams.get("after")).toBe("12");

    harness.realtime.stop();
  });

  it("pauses on a renderer delivery miss and replays only after a new ready start", async () => {
    let acceptMembership = false;
    const harness = createHarness({
      onEvent: (event) => event.type !== "channel.membership_changed" || acceptMembership,
    });

    harness.realtime.start("20", SCOPE_A);
    await flushMicrotasks();
    const firstSocket = harness.sockets[0];
    firstSocket?.message(connectedEvent({ workspaceSequence: "20" }));
    firstSocket?.message(membershipEvent({ workspaceSequence: "21" }));

    expect(firstSocket?.close).toHaveBeenCalledTimes(1);
    expect(harness.states).toEqual(["connecting", "live", "offline"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.ticket).toHaveBeenCalledTimes(1);

    acceptMembership = true;
    harness.realtime.start("20", SCOPE_A);
    await flushMicrotasks();
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(harness.urls[1]?.searchParams.get("after")).toBe("20");
    harness.sockets[1]?.message(membershipEvent({ workspaceSequence: "21" }));
    harness.sockets[1]?.message(connectedEvent({ workspaceSequence: "21" }));
    expect(harness.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "channel.membership_changed", workspaceSequence: "21" }),
    );
    expect(harness.states).toEqual(["connecting", "live", "offline", "connecting", "live"]);

    harness.realtime.stop();
  });

  it("retires the socket when renderer event delivery throws", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("renderer unavailable");
    });
    const harness = createHarness({ onEvent });

    harness.realtime.start("20", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    socket?.message(membershipEvent());
    socket?.message(connectedEvent());

    expect(socket?.close).toHaveBeenCalledTimes(1);
    expect(harness.states).toEqual(["connecting", "reconnecting"]);

    harness.realtime.stop();
  });

  it("retires a failed socket instead of waiting for a close callback", async () => {
    const harness = createHarness();

    harness.realtime.start("20", SCOPE_A);
    await flushMicrotasks();
    const socket = harness.sockets[0];
    socket?.fail();

    expect(socket?.close).toHaveBeenCalledTimes(1);
    expect(harness.states).toEqual(["connecting", "reconnecting"]);
    socket?.closed();
    expect(harness.states).toEqual(["connecting", "reconnecting"]);

    harness.realtime.stop();
  });

  it("keeps reconnecting when console logging fails with EIO", async () => {
    const writeFailure = Object.assign(new Error("write EIO"), { code: "EIO" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      throw writeFailure;
    });
    const harness = createHarness({
      ticket: vi.fn().mockRejectedValue(new Error("Server unavailable")),
    });

    harness.realtime.start("0", SCOPE_A);
    await flushMicrotasks();

    expect(harness.states).toEqual(["connecting", "reconnecting"]);
    expect(consoleError).toHaveBeenCalledWith(
      "Could not obtain a realtime ticket",
      expect.objectContaining({ message: "Server unavailable" }),
    );

    harness.realtime.stop();
  });
});
