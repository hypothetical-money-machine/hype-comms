import {
  AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS,
  type AgentCurrentPrincipal,
} from "@hype-comms/contracts";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedAgentIdentity } from "../src/modules/identity/service.js";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";

const agentUserId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const agentTokenId = "10000000-0000-4000-8000-000000000003";

const currentUser: AgentCurrentPrincipal = {
  type: "agent",
  user: {
    id: agentUserId,
    kind: "agent",
    username: "wake-agent",
    displayName: "Wake Agent",
    avatarUrl: null,
    title: null,
    createdAt: "2026-08-23T18:00:00.000Z",
    updatedAt: "2026-08-23T18:00:00.000Z",
  },
  workspaceId,
  role: "member",
  scopes: ["workspace:read"],
};

const identity: AuthenticatedAgentIdentity = {
  currentUser,
  principalKind: "agent",
  agentTokenId,
};

function conversationId(index: number): string {
  return `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function repositoryWithConversationRows(
  rows: readonly { readonly id: string; readonly kind: "channel" | "direct_message" }[],
) {
  const query = vi.fn(async (text: string, _parameters?: readonly unknown[]) => {
    void _parameters;
    if (text.startsWith("BEGIN TRANSACTION")) return { rows: [] };
    if (text.includes("SELECT last_event_sequence::text")) {
      return { rows: [{ last_event_sequence: "42" }] };
    }
    if (text.includes("SELECT conversation.id, conversation.kind")) return { rows: [...rows] };
    if (text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { repository: new WorkspaceRepository(pool), query, release };
}

describe("WorkspaceRepository agent wake bootstrap", () => {
  it("reads only a bounded ID/kind projection in one repeatable-read snapshot", async () => {
    const rows = [
      { id: conversationId(1), kind: "channel" as const },
      { id: conversationId(2), kind: "direct_message" as const },
    ];
    const { repository, query, release } = repositoryWithConversationRows(rows);

    await expect(repository.agentWakeBootstrap(identity)).resolves.toEqual({
      agentUserId,
      workspaceId,
      highWaterCursor: "42",
      conversations: [
        { conversationId: rows[0]?.id, kind: "channel" },
        { conversationId: rows[1]?.id, kind: "direct_message" },
      ],
    });

    const statements = query.mock.calls.map(([text]) => text);
    expect(statements[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements.at(-1)).toBe("COMMIT");
    const highWaterIndex = statements.findIndex((text) =>
      text.includes("SELECT last_event_sequence::text"),
    );
    const conversationsIndex = statements.findIndex((text) =>
      text.includes("SELECT conversation.id, conversation.kind"),
    );
    expect(highWaterIndex).toBeGreaterThan(0);
    expect(conversationsIndex).toBeGreaterThan(highWaterIndex);

    const conversationCall = query.mock.calls[conversationsIndex];
    expect(conversationCall).toBeDefined();
    const conversationSql = conversationCall?.[0] ?? "";
    expect(conversationSql).not.toMatch(/SELECT\s+\*/iu);
    expect(conversationSql).not.toMatch(/\bmessages?\b|\bbody\b/iu);
    expect(conversationCall?.[1]).toEqual([
      workspaceId,
      agentUserId,
      AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS + 1,
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails explicitly instead of truncating when the visible-conversation bound is exceeded", async () => {
    const rows = Array.from({ length: AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS + 1 }, (_, index) => ({
      id: conversationId(index),
      kind: "channel" as const,
    }));
    const { repository, query, release } = repositoryWithConversationRows(rows);

    await expect(repository.agentWakeBootstrap(identity)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      message: `Agent wake bootstrap exceeds ${AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS} visible conversations`,
    });
    expect(query.mock.calls.map(([text]) => text).at(-1)).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
