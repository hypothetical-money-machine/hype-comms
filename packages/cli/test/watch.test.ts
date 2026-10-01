import { testPosition } from "./support/sync-position.js";
import { execFile, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { productRealtimeEventSchema } from "@hype-comms/contracts";

import { executeCli } from "../src/cli.js";
import { ApiClient, RESPONSE_BODY_MAX_BYTES } from "../src/client.js";
import { MAX_RETRY_AFTER_MS } from "../src/errors.js";
import { laterCursor, watchProductRealtime, watchRetryDelayMs } from "../src/watch.js";
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
    expect(laterCursor(testPosition("9007199254740993"), testPosition("9007199254740994"))).toEqual(
      testPosition("9007199254740994"),
    );
    expect(laterCursor(testPosition("9007199254740994"), testPosition("9007199254740993"))).toEqual(
      testPosition("9007199254740994"),
    );
  });

  it("caps a server Retry-After at the configured maximum without dropping backoff jitter", () => {
    expect(watchRetryDelayMs(1, 0, () => 1)).toBe(625);
    expect(watchRetryDelayMs(6, MAX_RETRY_AFTER_MS, () => 1)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("does not refetch a ticket after an oversized response contract error", async () => {
    let ticketRequests = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/bootstrap") return jsonResponse(bootstrap());
      if (url.pathname === "/v2/realtime/tickets") {
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

  it("keeps reconnect at the old position until delayed output succeeds", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const origin = `http://127.0.0.1:${address.port}`;
    const abort = new AbortController();
    let release: () => void = () => undefined;
    const output = new Promise<void>((resolve) => {
      release = resolve;
    });
    const positions: string[] = [];
    const delivered: string[] = [];
    let second: WebSocket | undefined;
    const envelope = {
      version: 1,
      id: crypto.randomUUID(),
      occurredAt: TIMESTAMP,
      workspaceId: WORKSPACE_ID,
      conversationId: null,
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
    };
    const connected = productRealtimeEventSchema.parse({
      ...envelope,
      type: "system.connected",
      position: testPosition("5"),
      payload: { connectionId: crypto.randomUUID(), userId: USER_ID },
    });
    const member = productRealtimeEventSchema.parse({
      ...envelope,
      id: crypto.randomUUID(),
      type: "member.updated",
      position: testPosition("6"),
      payload: { member: bootstrap().currentUser.user },
    });
    server.on("connection", (socket, request) => {
      const url = new URL(request.url!, origin);
      positions.push((JSON.parse(url.searchParams.get("after")!) as { sequence: string }).sequence);
      if (positions.length === 1) {
        socket.send(JSON.stringify(connected));
        socket.send(JSON.stringify(member), () => socket.close(1011));
      } else if (positions.length === 2) second = socket;
      else
        socket.send(
          JSON.stringify({
            ...envelope,
            type: "system.resync_required",
            position: testPosition("6"),
            payload: { reason: "cursor_expired" },
          }),
        );
    });
    const client = new ApiClient({
      profile: {
        name: "test",
        apiOrigin: origin,
        credentialFromEnvironment: false,
        configDirectory: "/unused",
      },
      fetch: async () =>
        jsonResponse({ ticket: "t".repeat(32), position: testPosition("5"), expiresAt: TIMESTAMP }),
      timeoutMs: 5_000,
    });
    const watching = watchProductRealtime({
      client,
      origin,
      after: testPosition("5"),
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      timeoutMs: 5_000,
      random: () => 0,
      signal: abort.signal,
      async onEvent(event) {
        if (event.type === "member.updated") await output;
        delivered.push(event.type);
      },
    });
    const result = expect(watching).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
    try {
      await vi.waitFor(() => expect(positions).toHaveLength(2), { timeout: 2_000 });
      expect(positions).toEqual(["5", "5"]);
      expect(delivered).toEqual(["system.connected"]);
      release();
      await vi.waitFor(() => expect(delivered).toContain("member.updated"));
      second!.close(1011);
      await result;
      expect(positions).toEqual(["5", "5", "6"]);
    } finally {
      release();
      abort.abort();
      await watching.catch(() => undefined);
    }
  });

  it.each(["abort", "revoked", "resync"] as const)(
    "bounds shutdown after %s while output is stalled and ignores late completion",
    async (terminal) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      servers.push(server);
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing server address");
      const origin = `http://127.0.0.1:${address.port}`;
      const abort = new AbortController();
      let release: () => void = () => undefined;
      const output = new Promise<void>((resolve) => {
        release = resolve;
      });
      let socket: WebSocket | undefined;
      const delivered: string[] = [];
      server.on("connection", (connected) => {
        socket = connected;
        connected.send(
          JSON.stringify({
            version: 1,
            id: crypto.randomUUID(),
            type: "system.connected",
            occurredAt: TIMESTAMP,
            workspaceId: WORKSPACE_ID,
            conversationId: null,
            conversationSequence: null,
            position: testPosition("6"),
            entityVersion: 1,
            delivery: "at_least_once",
            payload: { connectionId: crypto.randomUUID(), userId: USER_ID },
          }),
        );
      });
      const client = new ApiClient({
        profile: {
          name: "test",
          apiOrigin: origin,
          credentialFromEnvironment: false,
          configDirectory: "/unused",
        },
        fetch: async () =>
          jsonResponse({
            ticket: "t".repeat(32),
            position: testPosition("5"),
            expiresAt: TIMESTAMP,
          }),
        timeoutMs: 5_000,
      });
      const watching = watchProductRealtime({
        client,
        origin,
        after: testPosition("5"),
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        timeoutMs: 5_000,
        random: () => 0,
        signal: abort.signal,
        async onEvent(event) {
          delivered.push(event.type);
          await output;
        },
      });
      const observed = watching.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.waitFor(() => expect(delivered).toEqual(["system.connected"]));
        if (terminal === "abort") abort.abort();
        else socket!.close(terminal === "revoked" ? 4401 : 4009);
        const outcome = await Promise.race([
          observed,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("Watch did not stop")), 1_500),
          ),
        ]);
        if (terminal === "abort") expect(outcome).toEqual({ value: { cursor: testPosition("5") } });
        else
          expect(outcome).toMatchObject({
            error: { code: terminal === "revoked" ? "REALTIME_AUTH_REVOKED" : "RESYNC_REQUIRED" },
          });
        release();
        await output;
        await Promise.resolve();
        expect(delivered).toEqual(["system.connected"]);
        expect(await observed).toEqual(outcome);
      } finally {
        release();
        abort.abort();
        await watching.catch(() => undefined);
      }
    },
  );

  it("exits the CLI after a signal when the real stdout pipe is unread", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const origin = `http://127.0.0.1:${address.port}`;
    server.on("connection", (socket) => {
      const envelope = {
        version: 1,
        occurredAt: TIMESTAMP,
        workspaceId: WORKSPACE_ID,
        entityVersion: 1,
        delivery: "at_least_once",
      };
      socket.send(
        JSON.stringify({
          ...envelope,
          id: crypto.randomUUID(),
          type: "system.connected",
          conversationId: null,
          conversationSequence: null,
          position: testPosition("5"),
          payload: { connectionId: crypto.randomUUID(), userId: USER_ID },
        }),
      );
      for (let sequence = 6; sequence < 206; sequence++) {
        socket.send(
          JSON.stringify({
            ...envelope,
            id: crypto.randomUUID(),
            type: "message.created",
            conversationId: CONVERSATION_ID,
            conversationSequence: String(sequence),
            position: testPosition(String(sequence)),
            payload: {
              message: {
                id: MESSAGE_ID,
                conversationId: CONVERSATION_ID,
                conversationSequence: String(sequence),
                version: 1,
                clientMessageId: CLIENT_MESSAGE_ID,
                authorId: USER_ID,
                threadRootId: null,
                body: "a".repeat(4_000),
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
      }
    });
    const script = `
      process.env.HYPE_COMMS_API_ORIGIN = ${JSON.stringify(origin)};
      process.env.HYPE_COMMS_TOKEN = ${JSON.stringify(`hype_comms_agent_${"a".repeat(43)}`)};
      process.env.HYPE_COMMS_CONFIG_DIR = ${JSON.stringify(await mkdtemp(join(tmpdir(), "hype-watch-pipe-")))};
      process.argv = [process.execPath, "hype-comms-cli", "watch", "--json"];
      globalThis.fetch = async (input) => new Response(JSON.stringify(
        new URL(String(input)).pathname === "/v2/bootstrap"
          ? ${JSON.stringify(bootstrap())}
          : { position: ${JSON.stringify(testPosition("5"))}, ticket: "t".repeat(32), expiresAt: ${JSON.stringify(TIMESTAMP)} }
      ), { headers: { "content-type": "application/json", "x-hype-comms-protocol": "2" } });
      const originalWrite = process.stdout.write.bind(process.stdout);
      let writes = 0;
      process.stdout.write = (chunk, callback) => {
        const result = originalWrite(chunk, callback);
        if (++writes === 2) setTimeout(() => process.stderr.write("OUTPUT_QUEUED\\n"), 100);
        return result;
      };
      process.stdin.once("data", () => {
        process.stdin.pause();
        process.emit("SIGTERM");
      });
      await import(${JSON.stringify(new URL("../dist/bin.js", import.meta.url).href)});
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString("utf8");
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    try {
      await vi.waitFor(() => expect(diagnostics).toContain("OUTPUT_QUEUED"), { timeout: 2_000 });
      child.stdin.end("stop\n");
      const exitCode = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("CLI remained alive with unread stdout")), 2_000),
        ),
      ]);
      expect(exitCode).toBe(0);
      expect(diagnostics).toBe("OUTPUT_QUEUED\n");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
      child.stdout.destroy();
    }
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
      observedCursors.push((JSON.parse(after) as { sequence: string }).sequence);
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
            position: testPosition("6"),
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
            position: testPosition("6"),
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
            position: testPosition("6"),
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
      if (url.pathname === "/v2/bootstrap") return jsonResponse(bootstrap());
      if (url.pathname === "/v2/realtime/tickets") {
        expect(new Headers(init?.headers).get("x-hype-comms-capabilities")).toBeNull();
        return jsonResponse({
          position: testPosition("5"),
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

    expect(
      await executeCli(["watch", "--json", "--after", JSON.stringify(testPosition("5"))], runtime),
    ).toBe(4);
    const records = runtime
      .stdoutText()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; workspaceSequence: string });
    expect(records).toEqual([
      expect.objectContaining({ type: "message.created", position: testPosition("6") }),
      expect.objectContaining({ type: "system.connected", position: testPosition("6") }),
      expect.objectContaining({ type: "system.resync_required", position: testPosition("6") }),
    ]);
    expect(observedCursors).toEqual(["5", "6"]);
    expect(observedPreambles).toEqual([null, null]);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "RESYNC_REQUIRED", retryable: false },
    });
  });

  it("requires bootstrap when pre-handshake replay exceeds the shared event limit", async () => {
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
        position: testPosition("6"),
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
      for (let index = 0; index <= 1_200; index += 1) {
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
          position: testPosition("6"),
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
          position: testPosition("6"),
          conversationSequence: null,
          entityVersion: 1,
          delivery: "at_least_once",
          payload: { reason: "client_replay_overflow" },
        }),
      );
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/bootstrap") return jsonResponse(bootstrap());
      if (url.pathname === "/v2/realtime/tickets") {
        return jsonResponse({
          position: testPosition("5"),
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

    expect(
      await executeCli(["watch", "--json", "--after", JSON.stringify(testPosition("5"))], runtime),
    ).toBe(4);
    const records = runtime
      .stdoutText()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload?: { reason?: string } });
    expect(records).toHaveLength(1);

    expect(records.at(-1)).toMatchObject({
      type: "system.resync_required",
      payload: { reason: "client_replay_overflow" },
    });
    expect(runtime.stdoutText()).toContain("client_replay_overflow");
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
          position: testPosition("5"),
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
      const testPosition = sequence => ({ epoch: ${JSON.stringify(testPosition("0").epoch)}, sequence });
      process.env.HYPE_COMMS_API_ORIGIN = ${JSON.stringify(origin)};
      process.env.HYPE_COMMS_TOKEN = ${JSON.stringify(`hype_comms_agent_${"a".repeat(43)}`)};
      process.argv = [process.execPath, "hype-comms-cli", "watch", "--json", "--after", JSON.stringify(testPosition("5"))];
      globalThis.fetch = async (input) => {
        const pathname = new URL(String(input)).pathname;
        const value = pathname === "/v2/bootstrap"
          ? ${JSON.stringify(bootstrap())}
          : pathname === "/v2/realtime/tickets"
            ? {
            position: testPosition("5"),
          ticket: "ticket_value_that_is_at_least_32_chars",
            expiresAt: "2026-07-26T21:00:00.000Z",
            }
            : null;
        if (value === null) throw new Error("Unexpected route " + pathname);
        return new Response(JSON.stringify(value), {
          status: 200,
          headers: { "content-type": "application/json", "x-hype-comms-protocol": "2" },
        });
      };
      const originalWrite = process.stdout.write.bind(process.stdout);
      let writeCount = 0;
      process.stdout.write = (_chunk, callback) => {
        writeCount += 1;
        if (writeCount === 2) throw new Error("stdout pipe failed");
        queueMicrotask(() => callback?.());
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
