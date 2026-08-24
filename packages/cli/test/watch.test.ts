import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import {
  ATTACHMENTS_CAPABILITY,
  MESSAGE_RETRACT_EVENTS_CAPABILITY,
  PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY,
  REACTION_EVENTS_CAPABILITY,
  READ_STATE_EVENTS_CAPABILITY,
} from "@hype-comms/contracts";

import { executeCli } from "../src/cli.js";
import { RESPONSE_BODY_MAX_BYTES } from "../src/client.js";
import { MAX_RETRY_AFTER_MS } from "../src/errors.js";
import {
  PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT,
  laterCursor,
  watchRetryDelayMs,
} from "../src/watch.js";
import {
  bootstrap,
  CLIENT_MESSAGE_ID,
  CONVERSATION_ID,
  MESSAGE_ID,
  TIMESTAMP,
  USER_ID,
  WORKSPACE_ID,
} from "./fixtures.js";
import { jsonResponse, testRuntime } from "./helpers.js";

const servers: WebSocketServer[] = [];
const execFileAsync = promisify(execFile);

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

describe("watch", () => {
  it("selects the later decimal cursor without losing integer precision", () => {
    expect(laterCursor("9007199254740993", "9007199254740994")).toBe("9007199254740994");
    expect(laterCursor("9007199254740994", "9007199254740993")).toBe("9007199254740994");
  });

  it("caps a server Retry-After at the configured maximum without dropping backoff jitter", () => {
    expect(watchRetryDelayMs(1, 0, () => 1)).toBe(625);
    expect(watchRetryDelayMs(6, MAX_RETRY_AFTER_MS, () => 1)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("does not refetch a ticket after an oversized response contract error", async () => {
    let ticketRequests = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/bootstrap") return jsonResponse(bootstrap());
      if (url.pathname === "/v1/realtime/tickets") {
        ticketRequests += 1;
        return jsonResponse({ padding: "a".repeat(RESPONSE_BODY_MAX_BYTES) }, { status: 503 });
      }
      throw new Error("Unexpected route");
    });
    const runtime = testRuntime({
      homeDirectory: await mkdtemp(join(tmpdir(), "hype-comms-watch-")),
      env: {
        HYPE_COMMS_API_ORIGIN: "https://chat.example.test",
        HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
      },
      fetch,
    });

    expect(await executeCli(["watch", "--json"], runtime)).toBe(6);
    expect(ticketRequests).toBe(1);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "INVALID_SERVER_CONTRACT", retryable: false },
    });
  });

  it("streams wire replay before the handshake, reconnects from its cursor, and exits with resync", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Missing test address");
    const observedCursors: string[] = [];
    const observedPreambles: (string | null)[] = [];
    let connection = 0;
    server.on("connection", (socket, request) => {
      connection += 1;
      const url = new URL(request.url ?? "/", `ws://127.0.0.1:${address.port}`);
      const after = url.searchParams.get("after") ?? "0";
      observedCursors.push(after);
      observedPreambles.push(url.searchParams.get("preamble"));
      if (connection === 1) {
        socket.send(
          JSON.stringify({
            version: 1,
            id: "66666666-6666-4666-8666-666666666666",
            type: "message.created",
            occurredAt: TIMESTAMP,
            workspaceId: WORKSPACE_ID,
            conversationId: CONVERSATION_ID,
            workspaceSequence: "6",
            conversationSequence: "1",
            entityVersion: 1,
            delivery: "at_least_once",
            payload: {
              message: {
                id: MESSAGE_ID,
                conversationId: CONVERSATION_ID,
                conversationSequence: "1",
                version: 1,
                clientMessageId: CLIENT_MESSAGE_ID,
                authorId: USER_ID,
                threadRootId: null,
                body: "hello",
                bodyFormat: "hype_comms_markdown_v1",
                editedAt: null,
                deletedAt: null,
                createdAt: TIMESTAMP,
                updatedAt: TIMESTAMP,
              },
              mentionedUserIds: [],
            },
          }),
        );
        socket.send(
          JSON.stringify({
            version: 1,
            id: "88888888-8888-4888-8888-888888888888",
            type: "system.connected",
            occurredAt: TIMESTAMP,
            workspaceId: WORKSPACE_ID,
            conversationId: null,
            workspaceSequence: "6",
            conversationSequence: null,
            entityVersion: 1,
            delivery: "at_least_once",
            payload: {
              connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              userId: USER_ID,
            },
          }),
          () => socket.close(1011, "retry"),
        );
      } else {
        socket.send(
          JSON.stringify({
            version: 1,
            id: "77777777-7777-4777-8777-777777777777",
            type: "system.resync_required",
            occurredAt: TIMESTAMP,
            workspaceId: WORKSPACE_ID,
            conversationId: null,
            workspaceSequence: "6",
            conversationSequence: null,
            entityVersion: 1,
            delivery: "at_least_once",
            payload: { reason: "cursor_expired" },
          }),
        );
      }
    });

    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/bootstrap") return jsonResponse(bootstrap());
      if (url.pathname === "/v1/realtime/tickets") {
        expect(new Headers(init?.headers).get("x-hype-comms-capabilities")).toBe(
          [
            ATTACHMENTS_CAPABILITY,
            REACTION_EVENTS_CAPABILITY,
            READ_STATE_EVENTS_CAPABILITY,
            PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY,
            MESSAGE_RETRACT_EVENTS_CAPABILITY,
          ].join(","),
        );
        return jsonResponse({
          ticket: "ticket_value_that_is_at_least_32_chars",
          expiresAt: "2026-07-26T21:00:00.000Z",
        });
      }
      throw new Error("Unexpected route");
    });
    const runtime = testRuntime({
      homeDirectory: await mkdtemp(join(tmpdir(), "hype-comms-watch-")),
      env: {
        HYPE_COMMS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
        HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
      },
      fetch,
    });

    expect(await executeCli(["watch", "--json", "--after", "5"], runtime)).toBe(4);
    const records = runtime
      .stdoutText()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; workspaceSequence: string });
    expect(records).toEqual([
      expect.objectContaining({ type: "message.created", workspaceSequence: "6" }),
      expect.objectContaining({ type: "system.connected", workspaceSequence: "6" }),
      expect.objectContaining({ type: "system.resync_required", workspaceSequence: "6" }),
    ]);
    expect(observedCursors).toEqual(["5", "6"]);
    expect(observedPreambles).toEqual([null, null]);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "RESYNC_REQUIRED", retryable: false },
    });
  });

  it("streams replay beyond the wake-only pre-handshake buffer limit", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Missing test address");
    server.on("connection", (socket) => {
      const frame = JSON.stringify({
        version: 1,
        id: "66666666-6666-4666-8666-666666666666",
        type: "message.created",
        occurredAt: TIMESTAMP,
        workspaceId: WORKSPACE_ID,
        conversationId: CONVERSATION_ID,
        workspaceSequence: "6",
        conversationSequence: "1",
        entityVersion: 1,
        delivery: "at_least_once",
        payload: {
          message: {
            id: MESSAGE_ID,
            conversationId: CONVERSATION_ID,
            conversationSequence: "1",
            version: 1,
            clientMessageId: CLIENT_MESSAGE_ID,
            authorId: USER_ID,
            threadRootId: null,
            body: "bounded replay",
            bodyFormat: "hype_comms_markdown_v1",
            editedAt: null,
            deletedAt: null,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          mentionedUserIds: [],
        },
      });
      for (let index = 0; index <= PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT; index += 1) {
        socket.send(frame);
      }
      socket.send(
        JSON.stringify({
          version: 1,
          id: "88888888-8888-4888-8888-888888888888",
          type: "system.connected",
          occurredAt: TIMESTAMP,
          workspaceId: WORKSPACE_ID,
          conversationId: null,
          workspaceSequence: "6",
          conversationSequence: null,
          entityVersion: 1,
          delivery: "at_least_once",
          payload: {
            connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            userId: USER_ID,
          },
        }),
      );
      socket.send(
        JSON.stringify({
          version: 1,
          id: "77777777-7777-4777-8777-777777777777",
          type: "system.resync_required",
          occurredAt: TIMESTAMP,
          workspaceId: WORKSPACE_ID,
          conversationId: null,
          workspaceSequence: "6",
          conversationSequence: null,
          entityVersion: 1,
          delivery: "at_least_once",
          payload: { reason: "cursor_expired" },
        }),
      );
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/bootstrap") return jsonResponse(bootstrap());
      if (url.pathname === "/v1/realtime/tickets") {
        return jsonResponse({
          ticket: "ticket_value_that_is_at_least_32_chars",
          expiresAt: "2026-07-26T21:00:00.000Z",
        });
      }
      throw new Error("Unexpected route");
    });
    const runtime = testRuntime({
      homeDirectory: await mkdtemp(join(tmpdir(), "hype-comms-watch-")),
      env: {
        HYPE_COMMS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
        HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
      },
      fetch,
    });

    expect(await executeCli(["watch", "--json", "--after", "5"], runtime)).toBe(4);
    const records = runtime
      .stdoutText()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload?: { reason?: string } });
    expect(records).toHaveLength(PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT + 3);
    expect(records[0]).toMatchObject({ type: "message.created" });
    expect(records[PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT + 1]).toMatchObject({
      type: "system.connected",
    });
    expect(records.at(-1)).toMatchObject({
      type: "system.resync_required",
      payload: { reason: "cursor_expired" },
    });
    expect(runtime.stdoutText()).not.toContain("client_replay_overflow");
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: {
        code: "RESYNC_REQUIRED",
        retryable: false,
      },
    });
  });

  it("rejects when a synthesized 4009 resync event cannot be written", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Missing test address");
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          version: 1,
          id: "88888888-8888-4888-8888-888888888888",
          type: "system.connected",
          occurredAt: TIMESTAMP,
          workspaceId: WORKSPACE_ID,
          conversationId: null,
          workspaceSequence: "5",
          conversationSequence: null,
          entityVersion: 1,
          delivery: "at_least_once",
          payload: {
            connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            userId: USER_ID,
          },
        }),
        () => socket.close(4009, "cursor expired"),
      );
    });

    const origin = `http://127.0.0.1:${address.port}`;
    const cliBundleUrl = new URL("../dist/bin.js", import.meta.url).href;
    const script = `
      process.env.HYPE_COMMS_API_ORIGIN = ${JSON.stringify(origin)};
      process.env.HYPE_COMMS_TOKEN = ${JSON.stringify(`hype_comms_agent_${"a".repeat(43)}`)};
      process.argv = [process.execPath, "hype-comms-cli", "wake", "watch", "--json", "--after", "5"];
      globalThis.fetch = async (input) => {
        const pathname = new URL(String(input)).pathname;
        const value = pathname === "/v1/agent-wake/bootstrap"
          ? {
              agentUserId: ${JSON.stringify(USER_ID)},
              workspaceId: ${JSON.stringify(WORKSPACE_ID)},
              highWaterCursor: "5",
              conversations: [],
            }
          : pathname === "/v1/realtime/tickets"
            ? {
            ticket: "ticket_value_that_is_at_least_32_chars",
            expiresAt: "2026-07-26T21:00:00.000Z",
            }
            : null;
        if (value === null) throw new Error("Unexpected route " + pathname);
        return new Response(JSON.stringify(value), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const originalWrite = process.stdout.write.bind(process.stdout);
      let writeCount = 0;
      process.stdout.write = () => {
        writeCount += 1;
        if (writeCount === 2) throw new Error("stdout pipe failed");
        return true;
      };
      await import(${JSON.stringify(cliBundleUrl)});
      const cliExitCode = process.exitCode;
      process.stdout.write = originalWrite;
      process.exitCode = 0;
      originalWrite(JSON.stringify({ cliExitCode, writeCount }));
    `;

    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        timeout: 2_000,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({ cliExitCode: 5, writeCount: 2 });
  });
});
