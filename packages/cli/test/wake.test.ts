import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import {
  AGENT_EFFECTIVE_SCOPES_CAPABILITY,
  GROUP_DIRECT_MESSAGES_CAPABILITY,
  agentWakeStreamRecordSchema,
  type AgentWakeBootstrapResponse,
  type AgentWakeCheckpoint,
  type AgentWakeStreamRecord,
  type ConversationKind,
  type ConversationSummary,
  type ProductRealtimeEvent,
} from "@hype-comms/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { executeCli } from "../src/cli.js";
import { PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT } from "../src/watch.js";
import { CONVERSATION_ID, TIMESTAMP, USER_ID, WORKSPACE_ID } from "./fixtures.js";
import { jsonResponse, testRuntime, type TestRuntime } from "./helpers.js";

const AUTHOR_ID = "10000000-0000-4000-8000-000000000001";
const CHANNEL_ID = "10000000-0000-4000-8000-000000000002";
const GROUP_DM_ID = "10000000-0000-4000-8000-000000000003";
const NEW_DM_ID = "10000000-0000-4000-8000-000000000004";
const MEMBERSHIP_CHANNEL_ID = "10000000-0000-4000-8000-000000000005";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function id(value: number): string {
  return `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function conversationSummary(conversationId: string, kind: ConversationKind): ConversationSummary {
  return {
    conversation: {
      id: conversationId,
      workspaceId: WORKSPACE_ID,
      kind,
      name: kind === "channel" ? "Engineering" : null,
      slug: kind === "channel" ? "engineering" : null,
      topic: null,
      access: kind === "channel" ? "workspace" : null,
      channelMode: kind === "channel" ? "chat" : null,
      isArchived: false,
      createdBy: USER_ID,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    participantIds:
      kind === "channel"
        ? []
        : kind === "direct_message"
          ? [USER_ID, AUTHOR_ID]
          : [USER_ID, AUTHOR_ID, id(99)],
    membershipRole: null,
    lastMessage: null,
    unreadCount: 0,
    mentionCount: 0,
    readCursor: null,
  };
}

function wakeBootstrap(
  conversations: AgentWakeBootstrapResponse["conversations"] = [
    { conversationId: CONVERSATION_ID, kind: "channel" },
  ],
  highWaterCursor = "5",
): AgentWakeBootstrapResponse {
  return {
    agentUserId: USER_ID,
    workspaceId: WORKSPACE_ID,
    highWaterCursor,
    conversations,
  };
}

function messageEvent(input: {
  readonly number: number;
  readonly sequence: number;
  readonly conversationId: string;
  readonly authorId?: string;
  readonly mentionedUserIds?: readonly string[];
  readonly body: string;
}): Extract<ProductRealtimeEvent, { type: "message.created" }> {
  const messageId = id(1_000 + input.number);
  return {
    version: 1,
    id: id(2_000 + input.number),
    type: "message.created",
    occurredAt: TIMESTAMP,
    workspaceId: WORKSPACE_ID,
    conversationId: input.conversationId,
    workspaceSequence: String(input.sequence),
    conversationSequence: String(input.sequence),
    entityVersion: 1,
    delivery: "at_least_once",
    payload: {
      message: {
        id: messageId,
        conversationId: input.conversationId,
        conversationSequence: String(input.sequence),
        version: 1,
        clientMessageId: messageId,
        authorId: input.authorId ?? AUTHOR_ID,
        threadRootId: null,
        body: input.body,
        bodyFormat: "hype_comms_markdown_v1",
        editedAt: null,
        deletedAt: null,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      mentionedUserIds: [...(input.mentionedUserIds ?? [])],
    },
  };
}

function conversationCreatedEvent(
  sequence: number,
  summary: ConversationSummary,
): ProductRealtimeEvent {
  return {
    version: 1,
    id: id(3_000 + sequence),
    type: "direct_conversation.created",
    occurredAt: TIMESTAMP,
    workspaceId: WORKSPACE_ID,
    conversationId: summary.conversation.id,
    workspaceSequence: String(sequence),
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: {
      conversation: summary.conversation,
      participantIds: [...summary.participantIds],
    },
  };
}

function repairEvent(sequence: number): ProductRealtimeEvent {
  return {
    version: 1,
    id: id(4_000 + sequence),
    type: "system.resync_required",
    occurredAt: TIMESTAMP,
    workspaceId: WORKSPACE_ID,
    conversationId: null,
    workspaceSequence: String(sequence),
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { reason: "cursor_expired" },
  };
}

function connectedEvent(sequence: string, number: number, userId = USER_ID): ProductRealtimeEvent {
  return {
    version: 1,
    id: id(6_000 + number),
    type: "system.connected",
    occurredAt: TIMESTAMP,
    workspaceId: WORKSPACE_ID,
    conversationId: null,
    workspaceSequence: sequence,
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { connectionId: id(7_000 + number), userId },
  };
}

function scanCheckpoint(cursor: string, agentUserId = USER_ID): AgentWakeCheckpoint {
  return {
    version: 1,
    type: "agent.wake.checkpoint",
    workspaceId: WORKSPACE_ID,
    agentUserId,
    cursor,
  };
}

type WakeRealtimeFrame = ProductRealtimeEvent | AgentWakeCheckpoint;

function frameCursor(frame: WakeRealtimeFrame): string {
  return frame.type === "agent.wake.checkpoint" ? frame.cursor : frame.workspaceSequence;
}

function channelMembershipEvent(sequence: number): ProductRealtimeEvent {
  return {
    version: 1,
    id: id(5_000 + sequence),
    type: "channel.membership_changed",
    occurredAt: TIMESTAMP,
    workspaceId: WORKSPACE_ID,
    conversationId: MEMBERSHIP_CHANNEL_ID,
    workspaceSequence: String(sequence),
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { memberId: USER_ID, action: "added" },
  };
}

function outputRecords(runtime: TestRuntime): AgentWakeStreamRecord[] {
  return runtime
    .stdoutText()
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => agentWakeStreamRecordSchema.parse(JSON.parse(line) as unknown));
}

async function runScenario(input: {
  readonly events: readonly WakeRealtimeFrame[];
  readonly bootstrap?: AgentWakeBootstrapResponse;
  readonly after?: string;
  readonly initialReplay?: boolean;
  readonly reconnectAfterFirstEvent?: boolean;
  readonly expectedExitCode?: number;
  readonly expectedErrorCode?: string;
}): Promise<{
  readonly runtime: TestRuntime;
  readonly observedAfter: readonly string[];
  readonly observedPreambles: readonly (string | null)[];
  readonly requestedPaths: readonly string[];
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address");
  const observedAfter: string[] = [];
  const observedPreambles: (string | null)[] = [];
  let connectionNumber = 0;
  server.on("connection", (socket, request) => {
    connectionNumber += 1;
    const url = new URL(request.url ?? "/", `ws://127.0.0.1:${address.port}`);
    const after = url.searchParams.get("after") ?? "0";
    observedAfter.push(after);
    observedPreambles.push(url.searchParams.get("preamble"));
    if (input.reconnectAfterFirstEvent === true) {
      socket.send(JSON.stringify(connectedEvent(after, connectionNumber)));
      if (connectionNumber === 1) {
        const first = input.events[0];
        if (first === undefined) throw new Error("Missing reconnect test event");
        socket.send(JSON.stringify(first), () => socket.close(1011, "retry"));
      } else {
        for (const event of input.events.slice(1)) socket.send(JSON.stringify(event));
      }
      return;
    }
    if (input.initialReplay === true) {
      const boundaryIndex = input.events.findIndex(
        (event) => event.type === "system.resync_required",
      );
      const replayEvents =
        boundaryIndex === -1 ? input.events : input.events.slice(0, boundaryIndex);
      const postBoundaryEvents = boundaryIndex === -1 ? [] : input.events.slice(boundaryIndex);
      let boundaryCursor = after;
      for (const event of replayEvents) {
        socket.send(JSON.stringify(event));
        const eventCursor = frameCursor(event);
        if (BigInt(eventCursor) > BigInt(boundaryCursor)) {
          boundaryCursor = eventCursor;
        }
      }
      socket.send(JSON.stringify(connectedEvent(boundaryCursor, connectionNumber)));
      for (const event of postBoundaryEvents) socket.send(JSON.stringify(event));
    } else {
      socket.send(JSON.stringify(connectedEvent(after, connectionNumber)));
      for (const event of input.events) socket.send(JSON.stringify(event));
    }
  });

  const requestedPaths: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
    const url = new URL(String(request));
    requestedPaths.push(url.pathname);
    if (url.pathname === "/v1/agent-wake/bootstrap") {
      return jsonResponse(input.bootstrap ?? wakeBootstrap());
    }
    if (url.pathname === "/v1/realtime/tickets") {
      expect(new Headers(init?.headers).get("x-hype-comms-capabilities")).toBe(
        `${GROUP_DIRECT_MESSAGES_CAPABILITY},${AGENT_EFFECTIVE_SCOPES_CAPABILITY}`,
      );
      return jsonResponse({
        ticket: "ticket_value_that_is_at_least_32_chars",
        expiresAt: "2026-07-26T21:00:00.000Z",
      });
    }
    throw new Error(`Unexpected route ${url.pathname}`);
  });
  const runtime = testRuntime({
    homeDirectory: await mkdtemp(join(tmpdir(), "hype-comms-wake-")),
    env: {
      HYPE_COMMS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
      HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
    },
    fetch,
  });
  const args = [
    "wake",
    "watch",
    "--json",
    ...(input.after === undefined ? [] : ["--after", input.after]),
  ];
  expect(await executeCli(args, runtime)).toBe(input.expectedExitCode ?? 4);
  expect(JSON.parse(runtime.stderrText())).toMatchObject({
    error: { code: input.expectedErrorCode ?? "RESYNC_REQUIRED", retryable: false },
  });
  return { runtime, observedAfter, observedPreambles, requestedPaths };
}

describe("wake watch", () => {
  it("emits no readiness record when the socket fails after bootstrap and ticketing", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test address");
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify(
          messageEvent({
            number: 12,
            sequence: 6,
            conversationId: CONVERSATION_ID,
            mentionedUserIds: [USER_ID],
            body: "revoked replay must remain private",
          }),
        ),
        () => socket.close(4401, "revoked before ready"),
      );
    });
    const requestedPaths: string[] = [];
    const runtime = testRuntime({
      homeDirectory: await mkdtemp(join(tmpdir(), "hype-comms-wake-")),
      env: {
        HYPE_COMMS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
        HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
      },
      fetch: vi.fn<typeof globalThis.fetch>(async (request) => {
        const url = new URL(String(request));
        requestedPaths.push(url.pathname);
        if (url.pathname === "/v1/agent-wake/bootstrap") return jsonResponse(wakeBootstrap());
        if (url.pathname === "/v1/realtime/tickets") {
          return jsonResponse({
            ticket: "ticket_value_that_is_at_least_32_chars",
            expiresAt: "2026-07-26T21:00:00.000Z",
          });
        }
        throw new Error(`Unexpected route ${url.pathname}`);
      }),
    });

    expect(await executeCli(["wake", "watch", "--json"], runtime)).toBe(3);
    expect(requestedPaths).toEqual(["/v1/agent-wake/bootstrap", "/v1/realtime/tickets"]);
    expect(runtime.stdoutText()).toBe("");
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "REALTIME_AUTH_REVOKED", retryable: false },
    });
  });

  it("validates the connected agent identity before releasing buffered replay", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test address");
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify(
          messageEvent({
            number: 11,
            sequence: 6,
            conversationId: CONVERSATION_ID,
            body: "must remain behind the identity boundary",
          }),
        ),
      );
      socket.send(JSON.stringify(connectedEvent("6", 1, id(98))));
    });
    const runtime = testRuntime({
      homeDirectory: await mkdtemp(join(tmpdir(), "hype-comms-wake-")),
      env: {
        HYPE_COMMS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
        HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
      },
      fetch: vi.fn<typeof globalThis.fetch>(async (request) => {
        const url = new URL(String(request));
        if (url.pathname === "/v1/agent-wake/bootstrap") {
          return jsonResponse(
            wakeBootstrap([{ conversationId: CONVERSATION_ID, kind: "direct_message" }]),
          );
        }
        if (url.pathname === "/v1/realtime/tickets") {
          return jsonResponse({
            ticket: "ticket_value_that_is_at_least_32_chars",
            expiresAt: "2026-07-26T21:00:00.000Z",
          });
        }
        throw new Error(`Unexpected route ${url.pathname}`);
      }),
    });

    expect(await executeCli(["wake", "watch", "--json", "--after", "5"], runtime)).toBe(6);
    expect(runtime.stdoutText()).toBe("");
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: {
        code: "INVALID_SERVER_CONTRACT",
        message: "Realtime connected with the wrong agent identity",
        retryable: false,
      },
    });
  });

  it("rejects a server scan checkpoint before the identity handshake", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test address");
    server.on("connection", (socket) => {
      socket.send(JSON.stringify(scanCheckpoint("8")));
    });
    const runtime = testRuntime({
      homeDirectory: await mkdtemp(join(tmpdir(), "hype-comms-wake-")),
      env: {
        HYPE_COMMS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
        HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
      },
      fetch: vi.fn<typeof globalThis.fetch>(async (request) => {
        const url = new URL(String(request));
        if (url.pathname === "/v1/agent-wake/bootstrap") return jsonResponse(wakeBootstrap());
        if (url.pathname === "/v1/realtime/tickets") {
          return jsonResponse({
            ticket: "ticket_value_that_is_at_least_32_chars",
            expiresAt: "2026-07-26T21:00:00.000Z",
          });
        }
        throw new Error(`Unexpected route ${url.pathname}`);
      }),
    });

    expect(await executeCli(["wake", "watch", "--json", "--after", "5"], runtime)).toBe(6);
    expect(runtime.stdoutText()).toBe("");
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: {
        code: "INVALID_SERVER_CONTRACT",
        message: "Realtime sent a Wake checkpoint before the connection event",
        retryable: false,
      },
    });
  });

  it("starts at the bootstrap cursor and emits no wake for a pre-enrollment frame", async () => {
    const snapshot = wakeBootstrap([{ conversationId: CONVERSATION_ID, kind: "direct_message" }]);
    const staleBody = "pre-enrollment secret body";
    const { runtime, observedAfter } = await runScenario({
      bootstrap: snapshot,
      events: [
        messageEvent({
          number: 1,
          sequence: 4,
          conversationId: CONVERSATION_ID,
          body: staleBody,
        }),
        repairEvent(5),
      ],
    });

    expect(observedAfter).toEqual(["5"]);
    expect(outputRecords(runtime)).toEqual([
      {
        version: 1,
        type: "agent.wake.checkpoint",
        workspaceId: WORKSPACE_ID,
        agentUserId: USER_ID,
        cursor: "5",
      },
      {
        version: 1,
        type: "agent.wake.checkpoint",
        workspaceId: WORKSPACE_ID,
        agentUserId: USER_ID,
        cursor: "5",
      },
      {
        version: 1,
        type: "agent.wake.repair_required",
        workspaceId: WORKSPACE_ID,
        agentUserId: USER_ID,
        cursor: "5",
        reason: "cursor_expired",
      },
    ]);
    expect(runtime.stdoutText()).not.toContain(staleBody);
  });

  it("requests the wake preamble and checkpoints its durable cursor before replay wakes", async () => {
    const replayBody = "body must never cross the wake output boundary";
    const { runtime, observedAfter, observedPreambles } = await runScenario({
      bootstrap: wakeBootstrap([{ conversationId: CONVERSATION_ID, kind: "direct_message" }]),
      after: "5",
      events: [
        messageEvent({
          number: 21,
          sequence: 6,
          conversationId: CONVERSATION_ID,
          body: replayBody,
        }),
        repairEvent(6),
      ],
    });

    expect(observedAfter).toEqual(["5"]);
    expect(observedPreambles).toEqual(["agent-wake-v1"]);
    expect(outputRecords(runtime)).toMatchObject([
      { type: "agent.wake.checkpoint", cursor: "5" },
      { type: "agent.wake", workspaceSequence: "6" },
      { type: "agent.wake.checkpoint", cursor: "6" },
      { type: "agent.wake.repair_required", cursor: "6", reason: "cursor_expired" },
    ]);
    expect(runtime.stdoutText()).not.toContain(replayBody);
  });

  it("resumes from a body-free server scan checkpoint", async () => {
    const { runtime, observedAfter } = await runScenario({
      after: "5",
      reconnectAfterFirstEvent: true,
      events: [scanCheckpoint("8"), repairEvent(8)],
    });

    expect(observedAfter).toEqual(["5", "8"]);
    expect(outputRecords(runtime)).toEqual([
      scanCheckpoint("5"),
      scanCheckpoint("8"),
      scanCheckpoint("8"),
      {
        version: 1,
        type: "agent.wake.repair_required",
        workspaceId: WORKSPACE_ID,
        agentUserId: USER_ID,
        cursor: "8",
        reason: "cursor_expired",
      },
    ]);
  });

  it("rejects a server scan checkpoint for another agent", async () => {
    const { runtime } = await runScenario({
      after: "5",
      events: [scanCheckpoint("8", id(98))],
      expectedExitCode: 6,
      expectedErrorCode: "INVALID_SERVER_CONTRACT",
    });

    expect(outputRecords(runtime)).toEqual([scanCheckpoint("5")]);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: {
        message: "Realtime checkpointed the wrong agent identity",
      },
    });
  });

  it("wakes for a DM and verified mention, but not text mentions, self messages, or group DMs", async () => {
    const snapshot = wakeBootstrap([
      { conversationId: CONVERSATION_ID, kind: "direct_message" },
      { conversationId: CHANNEL_ID, kind: "channel" },
      { conversationId: GROUP_DM_ID, kind: "group_direct_message" },
    ]);
    const bodies = [
      "private dm body",
      "verified channel body",
      "plain @hermes text only",
      "self-authored body",
      "unmentioned group body",
    ];
    const { runtime } = await runScenario({
      bootstrap: snapshot,
      events: [
        messageEvent({ number: 2, sequence: 6, conversationId: CONVERSATION_ID, body: bodies[0]! }),
        messageEvent({
          number: 3,
          sequence: 7,
          conversationId: CHANNEL_ID,
          mentionedUserIds: [USER_ID],
          body: bodies[1]!,
        }),
        messageEvent({ number: 4, sequence: 8, conversationId: CHANNEL_ID, body: bodies[2]! }),
        messageEvent({
          number: 5,
          sequence: 9,
          conversationId: CONVERSATION_ID,
          authorId: USER_ID,
          mentionedUserIds: [USER_ID],
          body: bodies[3]!,
        }),
        messageEvent({ number: 6, sequence: 10, conversationId: GROUP_DM_ID, body: bodies[4]! }),
        repairEvent(10),
      ],
    });
    const records = outputRecords(runtime);
    const wakes = records.filter((record) => record.type === "agent.wake");

    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.reason)).toEqual(["direct_message", "verified_mention"]);
    expect(wakes.map((wake) => wake.messageId)).toEqual([id(1_002), id(1_003)]);
    expect(wakes[0]?.wakeId).toMatch(/^[0-9a-f]{64}$/u);
    for (const body of bodies) expect(runtime.stdoutText()).not.toContain(body);
    expect(records.map((record) => record.type)).toEqual([
      "agent.wake.checkpoint",
      "agent.wake",
      "agent.wake.checkpoint",
      "agent.wake",
      "agent.wake.checkpoint",
      "agent.wake.checkpoint",
      "agent.wake.checkpoint",
      "agent.wake.checkpoint",
      "agent.wake.repair_required",
    ]);
  });

  it("replays from --after using only the body-free bootstrap projection", async () => {
    const { runtime, observedAfter, requestedPaths } = await runScenario({
      bootstrap: wakeBootstrap(
        [
          { conversationId: CHANNEL_ID, kind: "channel" },
          { conversationId: CONVERSATION_ID, kind: "direct_message" },
        ],
        "50",
      ),
      after: "5",
      initialReplay: true,
      events: [
        messageEvent({
          number: 7,
          sequence: 6,
          conversationId: CONVERSATION_ID,
          body: "replay body",
        }),
        repairEvent(6),
      ],
    });
    const records = outputRecords(runtime);

    expect(observedAfter).toEqual(["5"]);
    expect(requestedPaths).toEqual(["/v1/agent-wake/bootstrap", "/v1/realtime/tickets"]);
    expect(records.map((record) => record.type)).toEqual([
      "agent.wake",
      "agent.wake.checkpoint",
      "agent.wake.checkpoint",
      "agent.wake.repair_required",
    ]);
    expect(records[0]).toMatchObject({ reason: "direct_message", workspaceSequence: "6" });
    expect(records[1]).toMatchObject({ cursor: "6" });
    expect(records[2]).toMatchObject({ cursor: "6" });
    expect(records[3]).toMatchObject({ cursor: "6", reason: "cursor_expired" });
  });

  it("turns a bounded initial replay overflow into a body-free source repair", async () => {
    const events = Array.from(
      { length: PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT + 1 },
      (_, index) => channelMembershipEvent(index + 6),
    );
    const { runtime } = await runScenario({ events, initialReplay: true });

    expect(outputRecords(runtime)).toEqual([
      {
        version: 1,
        type: "agent.wake.repair_required",
        workspaceId: WORKSPACE_ID,
        agentUserId: USER_ID,
        cursor: "5",
        reason: "client_replay_overflow",
      },
    ]);
  });

  it("streams more than the legacy replay buffer limit after the wake preamble", async () => {
    const replayEvents = Array.from(
      { length: PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT + 1 },
      (_, index) => channelMembershipEvent(index + 6),
    );
    const finalCursor = String(PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT + 6);
    const { runtime, observedPreambles } = await runScenario({
      events: [...replayEvents, repairEvent(Number(finalCursor))],
    });
    const records = outputRecords(runtime);

    expect(observedPreambles).toEqual(["agent-wake-v1"]);
    expect(records).toHaveLength(PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT + 3);
    expect(records[0]).toMatchObject({ type: "agent.wake.checkpoint", cursor: "5" });
    expect(records.at(-2)).toMatchObject({
      type: "agent.wake.checkpoint",
      cursor: finalCursor,
    });
    expect(records.at(-1)).toMatchObject({
      type: "agent.wake.repair_required",
      cursor: finalCursor,
      reason: "cursor_expired",
    });
    expect(runtime.stdoutText()).not.toContain("client_replay_overflow");
  });

  it("updates DM and private-channel kinds from ordered realtime metadata", async () => {
    const newDm = conversationSummary(NEW_DM_ID, "direct_message");
    const { runtime } = await runScenario({
      bootstrap: wakeBootstrap(),
      events: [
        conversationCreatedEvent(6, newDm),
        messageEvent({ number: 8, sequence: 7, conversationId: NEW_DM_ID, body: "new dm body" }),
        channelMembershipEvent(8),
        messageEvent({
          number: 10,
          sequence: 9,
          conversationId: MEMBERSHIP_CHANNEL_ID,
          mentionedUserIds: [USER_ID],
          body: "new private channel mention",
        }),
        repairEvent(9),
      ],
    });
    const records = outputRecords(runtime);

    expect(records.map((record) => record.type)).toEqual([
      "agent.wake.checkpoint",
      "agent.wake.checkpoint",
      "agent.wake",
      "agent.wake.checkpoint",
      "agent.wake.checkpoint",
      "agent.wake",
      "agent.wake.checkpoint",
      "agent.wake.repair_required",
    ]);
    expect(records[2]).toMatchObject({ conversationId: NEW_DM_ID, reason: "direct_message" });
    expect(records[5]).toMatchObject({
      conversationId: MEMBERSHIP_CHANNEL_ID,
      reason: "verified_mention",
    });
  });

  it("uses the same wake id when an at-least-once event is redelivered", async () => {
    const snapshot = wakeBootstrap([{ conversationId: CONVERSATION_ID, kind: "direct_message" }]);
    const event = messageEvent({
      number: 9,
      sequence: 6,
      conversationId: CONVERSATION_ID,
      body: "duplicate delivery body",
    });
    const { runtime } = await runScenario({
      bootstrap: snapshot,
      events: [event, event, repairEvent(6)],
    });
    const wakes = outputRecords(runtime).filter((record) => record.type === "agent.wake");

    expect(wakes).toHaveLength(2);
    expect(wakes[0]?.wakeId).toBe(wakes[1]?.wakeId);
  });

  it("rejects profiles that are not authenticated as agents", async () => {
    const runtime = testRuntime({
      homeDirectory: await mkdtemp(join(tmpdir(), "hype-comms-wake-")),
      env: { HYPE_COMMS_API_ORIGIN: "https://chat.example.test" },
      fetch: vi.fn<typeof globalThis.fetch>(),
    });

    expect(await executeCli(["wake", "watch", "--json"], runtime)).toBe(2);
    expect(runtime.stdoutText()).toBe("");
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "AGENT_CREDENTIAL_REQUIRED", retryable: false },
    });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it("waits for stdout drain without restarting the wake stream", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test address");
    server.on("connection", (socket) => {
      socket.send(JSON.stringify(connectedEvent("5", 1)));
      socket.send(JSON.stringify(repairEvent(5)));
    });
    const runtime = testRuntime({
      homeDirectory: await mkdtemp(join(tmpdir(), "hype-comms-wake-")),
      env: {
        HYPE_COMMS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
        HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
      },
      fetch: vi.fn<typeof globalThis.fetch>(async (request) => {
        const url = new URL(String(request));
        if (url.pathname === "/v1/agent-wake/bootstrap") {
          return jsonResponse(wakeBootstrap());
        }
        if (url.pathname === "/v1/realtime/tickets") {
          return jsonResponse({
            ticket: "ticket_value_that_is_at_least_32_chars",
            expiresAt: "2026-07-26T21:00:00.000Z",
          });
        }
        throw new Error(`Unexpected route ${url.pathname}`);
      }),
    });
    const outputChunks: string[] = [];
    const firstWriteStarted = Promise.withResolvers<() => void>();
    let writeCount = 0;
    const blockedStdout = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        outputChunks.push(chunk.toString("utf8"));
        writeCount += 1;
        if (writeCount === 1) {
          firstWriteStarted.resolve(callback);
          return;
        }
        callback();
      },
    });
    const blockedRuntime: TestRuntime = {
      ...runtime,
      io: { ...runtime.io, stdout: blockedStdout },
    };

    let settled = false;
    const command = executeCli(["wake", "watch", "--json"], blockedRuntime).finally(() => {
      settled = true;
    });
    const releaseFirstWrite = await firstWriteStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseFirstWrite();

    expect(await command).toBe(4);
    expect(
      outputChunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => agentWakeStreamRecordSchema.parse(JSON.parse(line) as unknown)),
    ).toMatchObject([
      { type: "agent.wake.checkpoint", cursor: "5" },
      { type: "agent.wake.repair_required", cursor: "5", reason: "cursor_expired" },
    ]);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "RESYNC_REQUIRED", retryable: false },
    });
    expect(runtime.fetch).toHaveBeenCalledTimes(2);
    blockedStdout.destroy();
  });
});
