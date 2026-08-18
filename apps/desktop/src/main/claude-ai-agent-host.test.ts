import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { AiAgentHostError, type AiAgentHostCallbacks } from "./ai-agent-host";
import {
  ClaudeAcpHostError,
  type ClaudeAcpHost,
  type ClaudeAcpHostCallbacks,
} from "./claude-acp-host";
import { createClaudeAiAgentHost } from "./claude-ai-agent-host";

const WORKSPACE = "/private/projects/secret-repo";

class FakeClaudeHost implements ClaudeAcpHost {
  readonly newSessionCalls: string[] = [];
  readonly loadSessionCalls: Array<{ cwd: string; sessionId: string }> = [];
  readonly promptCalls: Array<{ sessionId: string; prompt: string }> = [];
  readonly cancelCalls: string[] = [];
  readonly closeCalls: string[] = [];
  disposeCalls = 0;

  async newSession(cwd: string) {
    this.newSessionCalls.push(cwd);
    return { sessionId: "claude-session" };
  }

  async loadSession(cwd: string, sessionId: string) {
    this.loadSessionCalls.push({ cwd, sessionId });
    return {};
  }

  async prompt(sessionId: string, prompt: string) {
    this.promptCalls.push({ sessionId, prompt });
    return { stopReason: "end_turn" as const };
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    this.closeCalls.push(sessionId);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

interface Harness {
  readonly callbacks: ClaudeAcpHostCallbacks;
  readonly events: Parameters<AiAgentHostCallbacks["onEvent"]>[0][];
  readonly exits: Parameters<AiAgentHostCallbacks["onExit"]>[0][];
  readonly permissionRequests: Parameters<AiAgentHostCallbacks["requestPermission"]>[0][];
  readonly host: FakeClaudeHost;
}

async function createHarness(): Promise<
  Harness & { readonly adapter: Awaited<ReturnType<typeof createClaudeAiAgentHost>> }
> {
  const events: Parameters<AiAgentHostCallbacks["onEvent"]>[0][] = [];
  const exits: Parameters<AiAgentHostCallbacks["onExit"]>[0][] = [];
  const permissionRequests: Parameters<AiAgentHostCallbacks["requestPermission"]>[0][] = [];
  const host = new FakeClaudeHost();
  let callbacks: ClaudeAcpHostCallbacks | null = null;
  const adapter = await createClaudeAiAgentHost(
    {
      onEvent: (event) => {
        events.push(event);
      },
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return { outcome: "selected", optionId: "allow-raw" };
      },
      onExit: (event) => exits.push(event),
    },
    {
      createHost: async (captured) => {
        callbacks = captured;
        return host;
      },
    },
  );
  if (callbacks === null) throw new Error("Claude callbacks were not captured");
  return { adapter, callbacks, events, exits, permissionRequests, host };
}

describe("createClaudeAiAgentHost", () => {
  it("maps Claude conversation operations to the neutral host", async () => {
    const harness = await createHarness();

    await expect(harness.adapter.newConversation(WORKSPACE)).resolves.toEqual({
      conversationId: "claude-session",
    });
    await harness.adapter.resumeConversation(WORKSPACE, "claude-session");
    await harness.adapter.prompt("claude-session", "Hello");
    await harness.adapter.cancel("claude-session");
    await harness.adapter.close("claude-session");
    await harness.adapter.dispose();

    expect(harness.host.newSessionCalls).toEqual([WORKSPACE]);
    expect(harness.host.loadSessionCalls).toEqual([
      { cwd: WORKSPACE, sessionId: "claude-session" },
    ]);
    expect(harness.host.promptCalls).toEqual([{ sessionId: "claude-session", prompt: "Hello" }]);
    expect(harness.host.cancelCalls).toEqual(["claude-session"]);
    expect(harness.host.closeCalls).toEqual(["claude-session"]);
    expect(harness.host.disposeCalls).toBe(1);
  });

  it("projects messages, tools, and plans without ACP-only payloads", async () => {
    const harness = await createHarness();
    const updates: SessionNotification[] = [
      {
        sessionId: "claude-session",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-message-raw",
          content: { type: "text", text: "Question" },
        },
      },
      {
        sessionId: "claude-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-raw",
          content: { type: "text", text: "Hello" },
        },
      },
      {
        sessionId: "claude-session",
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: null,
          content: { type: "text", text: "Thinking" },
        },
      },
      {
        sessionId: "claude-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-raw",
          title: "Read file",
          kind: "read",
          status: "in_progress",
          locations: [{ path: `${WORKSPACE}/file.ts`, line: 8 }],
          rawInput: { secret: "input" },
          rawOutput: { secret: "output" },
          _meta: { secret: "metadata" },
        },
      },
      {
        sessionId: "claude-session",
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "Inspect", priority: "high", status: "in_progress" }],
        },
      },
      {
        sessionId: "claude-session",
        update: { sessionUpdate: "plan_removed", planId: "plan-raw" },
      },
    ];

    for (const update of updates) await harness.callbacks.onSessionUpdate(update);

    expect(harness.events).toEqual([
      {
        type: "message-update",
        conversationId: "claude-session",
        messageId: "user-message-raw",
        role: "user",
        operation: "append",
        text: "Question",
      },
      {
        type: "message-update",
        conversationId: "claude-session",
        messageId: "message-raw",
        role: "assistant",
        operation: "append",
        text: "Hello",
      },
      {
        type: "message-update",
        conversationId: "claude-session",
        messageId: null,
        role: "thought",
        operation: "append",
        text: "Thinking",
      },
      {
        type: "tool-update",
        conversationId: "claude-session",
        isCreation: true,
        tool: {
          id: "tool-raw",
          title: "Read file",
          kind: "read",
          status: "in_progress",
          locations: [{ path: `${WORKSPACE}/file.ts`, line: 8 }],
        },
      },
      {
        type: "plan-replace",
        conversationId: "claude-session",
        entries: [{ content: "Inspect", priority: "high", status: "in_progress" }],
      },
      { type: "plan-remove", conversationId: "claude-session" },
    ]);
    expect(JSON.stringify(harness.events)).not.toMatch(/rawInput|rawOutput|metadata/u);
  });

  it("maps permission requests, selected outcomes, abort signals, and exits", async () => {
    const harness = await createHarness();
    const abortController = new AbortController();
    const request: RequestPermissionRequest = {
      sessionId: "claude-session",
      toolCall: {
        toolCallId: "tool-raw",
        title: "Edit file",
        kind: "edit",
        rawInput: { private: true },
      },
      options: [{ optionId: "allow-raw", name: "Allow once", kind: "allow_once" }],
    };

    await expect(
      harness.callbacks.requestPermission(request, abortController.signal),
    ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow-raw" } });
    expect(harness.permissionRequests).toEqual([
      {
        conversationId: "claude-session",
        tool: {
          id: "tool-raw",
          title: "Edit file",
          kind: "edit",
          status: undefined,
          locations: undefined,
        },
        options: [{ id: "allow-raw", name: "Allow once", kind: "allow_once" }],
      },
    ]);
    harness.callbacks.onExit({ reason: "exited", exitCode: 137 });
    expect(harness.exits).toEqual([{ reason: "exited" }]);
  });

  it("reduces Claude startup errors to stable neutral codes", async () => {
    const creation = createClaudeAiAgentHost(
      {
        onEvent: () => undefined,
        requestPermission: async () => ({ outcome: "cancelled" }),
        onExit: () => undefined,
      },
      {
        createHost: async () => {
          throw new ClaudeAcpHostError("claude-not-found");
        },
      },
    );

    await expect(creation).rejects.toEqual(new AiAgentHostError("not-installed"));
  });

  it("classifies session operation errors using the failed neutral operation", async () => {
    const host = new FakeClaudeHost();
    host.prompt = async () => {
      throw new ClaudeAcpHostError("session-operation-failed");
    };
    host.cancel = async () => {
      throw new ClaudeAcpHostError("session-operation-failed");
    };
    host.loadSession = async () => {
      throw new ClaudeAcpHostError("session-operation-failed");
    };
    const adapter = await createClaudeAiAgentHost(
      {
        onEvent: () => undefined,
        requestPermission: async () => ({ outcome: "cancelled" }),
        onExit: () => undefined,
      },
      { createHost: async () => host },
    );

    await expect(adapter.prompt("claude-session", "Hello")).rejects.toEqual(
      new AiAgentHostError("turn-failed"),
    );
    await expect(adapter.cancel("claude-session")).rejects.toEqual(
      new AiAgentHostError("turn-failed"),
    );
    await expect(adapter.resumeConversation(WORKSPACE, "claude-session")).rejects.toEqual(
      new AiAgentHostError("conversation-failed"),
    );
  });
});
