import { CONVERSATION_PAGE_MAX_LIMIT, type ConversationSummary } from "@hype-comms/contracts";
import type { PoolClient } from "pg";
import { DomainError } from "../../domain-errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";
import { conversationVisibilitySql } from "./conversation-access.js";
import { readConversationSummaries } from "./conversation-summary-reader.js";
import { UUID_PATTERN } from "./pagination.js";
import { type ConversationRow } from "./records.js";

/** One bounded page of conversation summaries plus the keyset cursor that follows it. */
export interface ConversationPage {
  readonly conversations: ConversationSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export function encodeConversationCursor(conversationId: string): string {
  return Buffer.from(JSON.stringify({ id: conversationId }), "utf8").toString("base64url");
}

/**
 * Decode the opaque keyset cursor back into the anchor conversation id. A cursor that does not
 * carry a conversation id is a client error, not a server fault, so it is rejected with 400
 * instead of failing the whole listing.
 */
export function decodeConversationCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new Error("Invalid cursor");
    }
    return parsed.id;
  } catch {
    throw new DomainError("invalid_input", "Invalid conversation cursor");
  }
}

/**
 * One page of the member's visible conversations.
 *
 * The listing is keyset-paginated over the existing deterministic ordering
 * `(kind, lower(coalesce(name, '')), created_at, id)`. Because that tuple ends in the primary
 * key it is a total order, so the row-value comparison against the anchor row walks every
 * conversation exactly once with no duplicates and no skips. `LIMIT pageLimit + 1` is what
 * detects a further page. Summary details are read in batches for the selected IDs only.
 *
 * The page size is clamped to the contract's maximum as well as validated at the route, so no
 * caller can ever produce a response too large for its own schema to accept.
 */
export async function readConversationPage(
  client: PoolClient,
  identity: AuthenticatedIdentity,
  after: string | null,
  limit: number,
): Promise<ConversationPage> {
  const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), CONVERSATION_PAGE_MAX_LIMIT);
  const result = await client.query<ConversationRow>(
    `SELECT *
         FROM conversations AS conversation
        WHERE conversation.workspace_id = $1
          AND ${conversationVisibilitySql("conversation", "$2")}
          AND (
            $3::uuid IS NULL
            OR (
              conversation.kind,
              lower(coalesce(conversation.name, '')),
              conversation.created_at,
              conversation.id
            ) >
               (
                 SELECT anchor.kind,
                        lower(coalesce(anchor.name, '')),
                        anchor.created_at,
                        anchor.id
                   FROM conversations AS anchor
                  WHERE anchor.id = $3::uuid
                    AND anchor.workspace_id = $1
                    AND (
                      ${conversationVisibilitySql("anchor", "$2")}
                      OR (
                        anchor.kind = 'channel'
                        AND anchor.channel_access = 'members'
                        AND NOT anchor.human_only
                        AND EXISTS (
                          SELECT 1
                            FROM conversation_memberships AS anchor_membership
                           WHERE anchor_membership.conversation_id = anchor.id
                             AND anchor_membership.user_id = $2
                        )
                      )
                    )
               )
          )
        ORDER BY conversation.kind, lower(coalesce(conversation.name, '')),
                 conversation.created_at, conversation.id
        LIMIT $4`,
    [identity.currentUser.workspaceId, identity.currentUser.user.id, after, pageLimit + 1],
  );
  const rows = result.rows.slice(0, pageLimit);
  const summaries = await readConversationSummaries(client, identity.currentUser.user.id, rows);
  const last = rows.at(-1);
  const nextCursor =
    result.rows.length > pageLimit && last !== undefined ? encodeConversationCursor(last.id) : null;
  return { conversations: summaries, nextCursor, hasMore: nextCursor !== null };
}
