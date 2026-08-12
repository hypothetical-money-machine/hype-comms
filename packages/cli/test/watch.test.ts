import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { REACTION_EVENTS_CAPABILITY, READ_STATE_EVENTS_CAPABILITY } from "@hype-comms/contracts";

import { executeCli } from "../src/cli.js";
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
  it("emits pure NDJSON, reconnects from the last cursor, and exits with resync", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Missing test address");
    const observedCursors: string[] = [];
    let connection = 0;
    server.on("connection", (socket, request) => {
      connection += 1;
      const url = new URL(request.url ?? "/", `ws://127.0.0.1:${address.port}`);
      observedCursors.push(url.searchParams.get("after") ?? "");
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
          `${REACTION_EVENTS_CAPABILITY},${READ_STATE_EVENTS_CAPABILITY}`,
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
      expect.objectContaining({ type: "system.resync_required", workspaceSequence: "6" }),
    ]);
    expect(observedCursors).toEqual(["5", "6"]);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "RESYNC_REQUIRED", retryable: false },
    });
  });
});
