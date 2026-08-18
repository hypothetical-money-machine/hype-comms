import type {
  AiChannelMessage,
  AiChannelPermissionOption,
  AiChannelToolCall,
} from "@hype-comms/contracts";

export type AiAgentHostErrorCode =
  | "not-installed"
  | "not-authenticated"
  | "unsupported-version"
  | "startup-failed"
  | "protocol-failed"
  | "conversation-failed"
  | "turn-failed";

export class AiAgentHostError extends Error {
  constructor(readonly code: AiAgentHostErrorCode) {
    super(`AI agent host failed: ${code}`);
    this.name = "AiAgentHostError";
  }
}

export interface AiAgentHostLocation {
  readonly path: string;
  readonly line?: number | null;
}

export interface AiAgentHostTool {
  readonly id: string;
  readonly title?: string | null;
  readonly kind?: AiChannelToolCall["kind"] | null;
  readonly status?: AiChannelToolCall["status"] | "declined" | null;
  readonly locations?: readonly AiAgentHostLocation[] | null;
}

export interface AiAgentHostPlanEntry {
  readonly content: string;
  readonly priority: "high" | "medium" | "low" | null;
  readonly status: "pending" | "in_progress" | "completed";
}

export type AiAgentHostEvent =
  | {
      readonly type: "message-update";
      readonly conversationId: string;
      readonly messageId: string | null;
      readonly role: AiChannelMessage["role"];
      readonly operation: "append" | "replace";
      readonly text: string;
    }
  | {
      readonly type: "tool-update";
      readonly conversationId: string;
      readonly tool: AiAgentHostTool;
      readonly isCreation: boolean;
    }
  | {
      readonly type: "plan-replace";
      readonly conversationId: string;
      readonly entries: readonly AiAgentHostPlanEntry[];
    }
  | { readonly type: "plan-remove"; readonly conversationId: string };

export interface AiAgentHostPermissionRequest {
  readonly conversationId: string;
  readonly tool: AiAgentHostTool;
  readonly options: readonly AiChannelPermissionOption[];
}

export type AiAgentHostPermissionOutcome =
  { readonly outcome: "selected"; readonly optionId: string } | { readonly outcome: "cancelled" };

export interface AiAgentHostExit {
  readonly reason: "exited" | "launch-failed" | "transport-failed";
}

export interface AiAgentHostCallbacks {
  readonly onEvent: (event: AiAgentHostEvent) => void | Promise<void>;
  readonly requestPermission: (
    request: AiAgentHostPermissionRequest,
    signal: AbortSignal,
  ) => Promise<AiAgentHostPermissionOutcome>;
  readonly onExit: (event: AiAgentHostExit) => void;
}

export interface AiAgentHost {
  newConversation(workspacePath: string): Promise<{ readonly conversationId: string }>;
  resumeConversation(workspacePath: string, conversationId: string): Promise<void>;
  prompt(conversationId: string, prompt: string): Promise<void>;
  cancel(conversationId: string): Promise<void>;
  close(conversationId: string): Promise<void>;
  dispose(): Promise<void>;
}

export type CreateAiAgentHost = (callbacks: AiAgentHostCallbacks) => Promise<AiAgentHost>;
