import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

import {
  AiAgentHostError,
  type AiAgentHost,
  type AiAgentHostCallbacks,
  type AiAgentHostErrorCode,
  type AiAgentHostEvent,
  type AiAgentHostPermissionOutcome,
  type AiAgentHostPermissionRequest,
  type AiAgentHostTool,
} from "./ai-agent-host";
import {
  ClaudeAcpHostError,
  createClaudeAcpHost,
  type ClaudeAcpHost,
  type ClaudeAcpHostErrorCode,
  type CreateClaudeAcpHost,
} from "./claude-acp-host";

export interface ClaudeAiAgentHostDependencies {
  readonly createHost?: CreateClaudeAcpHost;
}

function errorCodeForClaude(
  code: ClaudeAcpHostErrorCode,
  fallback: AiAgentHostErrorCode,
): AiAgentHostErrorCode {
  switch (code) {
    case "claude-not-found":
      return "not-installed";
    case "worker-launch-failed":
      return "startup-failed";
    case "connection-failed":
      return "protocol-failed";
    case "invalid-workspace":
      return "conversation-failed";
    case "session-operation-failed":
      return fallback;
  }
}

function neutralError(error: unknown, fallback: AiAgentHostErrorCode): AiAgentHostError {
  return new AiAgentHostError(
    error instanceof ClaudeAcpHostError ? errorCodeForClaude(error.code, fallback) : fallback,
  );
}

function projectTool(tool: ToolCall | ToolCallUpdate): AiAgentHostTool {
  return {
    id: tool.toolCallId,
    title: tool.title,
    kind: tool.kind,
    status: tool.status,
    locations: tool.locations?.map((location) => ({
      path: location.path,
      line: location.line,
    })),
  };
}

function projectSessionUpdate(notification: SessionNotification): AiAgentHostEvent | null {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text") return null;
      const role =
        update.sessionUpdate === "user_message_chunk"
          ? "user"
          : update.sessionUpdate === "agent_message_chunk"
            ? "assistant"
            : "thought";
      return {
        type: "message-update",
        conversationId: notification.sessionId,
        messageId: update.messageId ?? null,
        role,
        operation: "append",
        text: update.content.text,
      };
    }
    case "tool_call":
      return {
        type: "tool-update",
        conversationId: notification.sessionId,
        tool: projectTool(update),
        isCreation: true,
      };
    case "tool_call_update":
      return {
        type: "tool-update",
        conversationId: notification.sessionId,
        tool: projectTool(update),
        isCreation: false,
      };
    case "plan":
      return {
        type: "plan-replace",
        conversationId: notification.sessionId,
        entries: update.entries,
      };
    case "plan_update":
      return update.plan.type === "items"
        ? {
            type: "plan-replace",
            conversationId: notification.sessionId,
            entries: update.plan.entries,
          }
        : null;
    case "plan_removed":
      return { type: "plan-remove", conversationId: notification.sessionId };
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
      return null;
  }
  return null;
}

function projectPermissionRequest(request: RequestPermissionRequest): AiAgentHostPermissionRequest {
  return {
    conversationId: request.sessionId,
    tool: projectTool(request.toolCall),
    options: request.options.map((option) => ({
      id: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
}

function projectPermissionResponse(
  outcome: AiAgentHostPermissionOutcome,
): RequestPermissionResponse {
  return { outcome };
}

class ClaudeAiAgentHost implements AiAgentHost {
  constructor(private readonly host: ClaudeAcpHost) {}

  async newConversation(workspacePath: string): Promise<{ conversationId: string }> {
    try {
      const response = await this.host.newSession(workspacePath);
      return { conversationId: response.sessionId };
    } catch (error) {
      throw neutralError(error, "conversation-failed");
    }
  }

  async resumeConversation(workspacePath: string, conversationId: string): Promise<void> {
    try {
      await this.host.loadSession(workspacePath, conversationId);
    } catch (error) {
      throw neutralError(error, "conversation-failed");
    }
  }

  async prompt(conversationId: string, prompt: string): Promise<void> {
    try {
      await this.host.prompt(conversationId, prompt);
    } catch (error) {
      throw neutralError(error, "turn-failed");
    }
  }

  async cancel(conversationId: string): Promise<void> {
    try {
      await this.host.cancel(conversationId);
    } catch (error) {
      throw neutralError(error, "turn-failed");
    }
  }

  async close(conversationId: string): Promise<void> {
    try {
      await this.host.close(conversationId);
    } catch (error) {
      throw neutralError(error, "conversation-failed");
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.host.dispose();
    } catch (error) {
      throw neutralError(error, "protocol-failed");
    }
  }
}

export async function createClaudeAiAgentHost(
  callbacks: AiAgentHostCallbacks,
  dependencies: ClaudeAiAgentHostDependencies = {},
): Promise<AiAgentHost> {
  let host: ClaudeAcpHost;
  try {
    host = await (dependencies.createHost ?? createClaudeAcpHost)({
      onSessionUpdate: async (notification) => {
        const event = projectSessionUpdate(notification);
        if (event !== null) await callbacks.onEvent(event);
      },
      requestPermission: async (request, signal) =>
        projectPermissionResponse(
          await callbacks.requestPermission(projectPermissionRequest(request), signal),
        ),
      onExit: (event) => callbacks.onExit({ reason: event.reason }),
    });
  } catch (error) {
    throw neutralError(error, "startup-failed");
  }
  return new ClaudeAiAgentHost(host);
}
