import { EventEmitter } from "node:events";
import {
  productRealtimeEventSchema,
  type ProductRealtimeEvent,
  type SyncPosition,
} from "@hype-comms/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceRealtimeClient,
  REALTIME_REPLAY_MAX_EVENTS,
  decodeRealtimeData,
  REALTIME_FRAME_MAX_BYTES,
  type RealtimeFailure,
} from "../src/index.js";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const epoch = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-12T00:00:00.000Z";
const position = (sequence: number): SyncPosition => ({ epoch, sequence: String(sequence) });
function frame(sequence: number, connected = false): ProductRealtimeEvent {
  return productRealtimeEventSchema.parse({
    version: 1,
    id: crypto.randomUUID(),
    type: connected ? "system.connected" : "member.updated",
    occurredAt: now,
    workspaceId,
    conversationId: null,
    conversationSequence: null,
    position: position(sequence),
    entityVersion: 1,
    delivery: "at_least_once",
    payload: connected
      ? { connectionId: crypto.randomUUID(), userId }
      : {
          member: {
            id: userId,
            kind: "human",
            username: "member",
            displayName: "Member",
            avatarUrl: null,
            title: null,
            createdAt: now,
            updatedAt: now,
          },
        },
  });
}
class Socket extends EventEmitter {
  readonly readyState = 1;
  readonly bufferedAmount = 0;
  close = vi.fn();
  terminate = vi.fn();
  send = vi.fn();
  frame(event: ProductRealtimeEvent): void {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }
}
function setup() {
  const sockets: Socket[] = [];
  const positions: SyncPosition[] = [];
  const events: ProductRealtimeEvent[] = [];
  const failures: RealtimeFailure[] = [];
  const realtime = new WorkspaceRealtimeClient({
    apiOrigin: "https://chat.example",
    clientOrigin: "https://chat.example",
    transport: {
      ticket: async () => ({ ticket: "t".repeat(32), expiresAt: now, position: position(0) }),
    },
    createSocket(url) {
      positions.push(JSON.parse(url.searchParams.get("after")!) as SyncPosition);
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    reconnectDelay: () => 1,
    onEvent({ event }) {
      events.push(event);
      return true;
    },
    onState() {},
    onFailure(failure) {
      failures.push(failure);
      return failure.kind === "invalid_frame";
    },
  });
  const scope = realtime.prepare({ after: position(0), userId, workspaceId });
  realtime.activate(scope);
  return { realtime, scope, sockets, positions, events, failures };
}

describe("shared realtime delivery", () => {
  it("cancels an outstanding ticket when its session is retired", async () => {
    let signal: AbortSignal | undefined;
    const socket = vi.fn(() => new Socket());
    const realtime = new WorkspaceRealtimeClient({
      apiOrigin: "https://chat.example",
      clientOrigin: "https://chat.example",
      transport: {
        ticket: async (pending) => {
          signal = pending;
          return new Promise((_resolve, reject) =>
            pending.addEventListener("abort", () => reject(pending.reason), { once: true }),
          );
        },
      },
      createSocket: socket,
      onEvent: () => true,
      onState() {},
    });
    const scope = realtime.prepare({ after: position(0), userId, workspaceId });
    realtime.activate(scope);
    expect(signal?.aborted).toBe(false);
    realtime.resetSession();
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(socket).not.toHaveBeenCalled();
  });
  it("resumes only from an explicit consumer acknowledgement", async () => {
    const state = setup();
    try {
      await vi.waitFor(() => expect(state.sockets).toHaveLength(1));
      state.sockets[0]!.frame(frame(0, true));
      state.sockets[0]!.frame(frame(1));
      state.sockets[0]!.emit("close", 1006);
      await vi.waitFor(() => expect(state.sockets).toHaveLength(2));
      expect(state.positions[1]).toEqual(position(0));
      state.realtime.acknowledge({
        scope: state.scope,
        cursor: { ...position(99), epoch: crypto.randomUUID() },
      });
      state.realtime.acknowledge({ scope: state.scope, cursor: position(1) });
      state.sockets[1]!.emit("close", 1006);
      await vi.waitFor(() => expect(state.sockets).toHaveLength(3));
      expect(state.positions[2]).toEqual(position(1));
    } finally {
      state.realtime.resetSession();
    }
  });

  it.each([false, true])(
    "bounds %s live delivery while the consumer has not acknowledged",
    async (live) => {
      const state = setup();
      try {
        await vi.waitFor(() => expect(state.sockets).toHaveLength(1));
        const socket = state.sockets[0]!;
        if (live) socket.frame(frame(0, true));
        for (let sequence = 1; sequence <= REALTIME_REPLAY_MAX_EVENTS + 1; sequence++)
          socket.frame(frame(sequence));
        const recovery = state.events.at(-1);
        expect(recovery).toMatchObject({
          type: "system.resync_required",
          position: position(0),
          payload: { reason: "client_replay_overflow" },
        });
        expect(state.events.filter((event) => event.type === "member.updated")).toHaveLength(
          live ? REALTIME_REPLAY_MAX_EVENTS : 0,
        );
        expect(socket.close).toHaveBeenCalledWith(1009, expect.any(String));
      } finally {
        state.realtime.resetSession();
      }
    },
  );

  it("rejects binary frames before consumer delivery", async () => {
    const state = setup();
    try {
      await vi.waitFor(() => expect(state.sockets).toHaveLength(1));
      state.sockets[0]!.emit("message", Buffer.from(JSON.stringify(frame(0, true))), true);
      expect(state.events).toEqual([]);
      expect(state.failures).toContainEqual({ kind: "invalid_frame" });
    } finally {
      state.realtime.resetSession();
    }
  });

  it("bounds byte chunks before parsing and rejects invalid UTF-8", () => {
    expect(() => decodeRealtimeData(new Uint8Array(REALTIME_FRAME_MAX_BYTES + 1), false)).toThrow(
      "byte limit",
    );
    expect(() => decodeRealtimeData(new Uint8Array([0xc0, 0x80]), false)).toThrow();
    const data = new TextEncoder().encode('{"value":"😀"}');
    expect(decodeRealtimeData([data.subarray(0, 7), data.subarray(7)], false)).toEqual({
      value: { value: "😀" },
      frameBytes: data.byteLength,
    });
  });
});
