import { randomUUID } from "node:crypto";

import { workspaceEventSchema, type WorkspaceEvent } from "@hmm-chat/contracts";
import type { PoolClient, QueryResultRow } from "pg";

/**
 * Everything needed to publish one entry onto the workspace sync-event pipeline
 * (`sync_events` + `sync_event_audiences` + the `hmm_chat_events` `pg_notify` channel), without
 * assuming the caller is mutating a conversation. Workspace mutations and agent lifecycle
 * changes both go through this shape so there is exactly one place that knows how a sync event
 * reaches Postgres and wakes up listening sockets.
 */
export interface WorkspaceSyncEventInput {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly type: WorkspaceEvent["type"];
  readonly conversationId: string | null;
  readonly conversationSequence?: string | null | undefined;
  readonly entityVersion?: number | undefined;
  readonly payload: WorkspaceEvent["payload"];
  /** Defaults to every active workspace member when omitted. */
  readonly audienceUserIds?: readonly string[] | undefined;
}

/**
 * Bump `workspaces.last_event_sequence` and return the newly allocated value. Callers that need
 * the sequence before the event row exists (for example to stamp it onto another row in the same
 * statement) can call this directly and then {@link insertSyncEventWithSequence}.
 */
export async function nextWorkspaceSequence(
  client: PoolClient,
  workspaceId: string,
): Promise<string> {
  const result = await client.query<{ next: string } & QueryResultRow>(
    `UPDATE workspaces
        SET last_event_sequence = last_event_sequence + 1,
            updated_at = clock_timestamp()
      WHERE id = $1
      RETURNING last_event_sequence::text AS next`,
    [workspaceId],
  );
  const sequence = result.rows[0]?.next;
  if (sequence === undefined) throw new Error("Could not allocate workspace event sequence");
  return sequence;
}

/**
 * Insert a sync event at an already-allocated sequence, fan it out to its audience, and notify
 * listening sockets. Must run on the same `PoolClient`/transaction as the mutation the event
 * describes: if that transaction rolls back the event must never be observed, and a committed
 * mutation must never end up missing its event.
 */
export async function insertSyncEventWithSequence(
  client: PoolClient,
  sequence: string,
  input: WorkspaceSyncEventInput,
): Promise<WorkspaceEvent> {
  const occurredAt = new Date().toISOString();
  const event = workspaceEventSchema.parse({
    version: 1,
    id: randomUUID(),
    type: input.type,
    occurredAt,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    workspaceSequence: sequence,
    conversationSequence: input.conversationSequence ?? null,
    entityVersion: input.entityVersion ?? 1,
    delivery: "at_least_once",
    payload: input.payload,
  });
  await client.query(
    `INSERT INTO sync_events (
       id, workspace_id, workspace_sequence, conversation_id, conversation_sequence,
       event_type, actor_user_id, entity_version, payload, occurred_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [
      event.id,
      event.workspaceId,
      event.workspaceSequence,
      event.conversationId,
      event.conversationSequence,
      event.type,
      input.actorUserId,
      event.entityVersion,
      JSON.stringify(event.payload),
      event.occurredAt,
    ],
  );
  if (input.audienceUserIds === undefined) {
    await client.query(
      `INSERT INTO sync_event_audiences (event_id, workspace_id, user_id)
       SELECT $1, $2, membership.user_id
         FROM workspace_memberships AS membership
         JOIN users AS user_account ON user_account.id = membership.user_id
        WHERE membership.workspace_id = $2
          AND membership.status = 'active'
          AND user_account.kind IN ('human', 'agent')`,
      [event.id, event.workspaceId],
    );
  } else {
    await client.query(
      `INSERT INTO sync_event_audiences (event_id, workspace_id, user_id)
       SELECT $1, $2, unnest($3::uuid[])`,
      [event.id, event.workspaceId, [...input.audienceUserIds]],
    );
  }
  await client.query(`SELECT pg_notify('hmm_chat_events', $1)`, [
    `${event.workspaceId}:${event.workspaceSequence}`,
  ]);
  return event;
}

/** Allocate the next workspace sequence and insert the event in one call. */
export async function insertSyncEvent(
  client: PoolClient,
  input: WorkspaceSyncEventInput,
): Promise<WorkspaceEvent> {
  const sequence = await nextWorkspaceSequence(client, input.workspaceId);
  return insertSyncEventWithSequence(client, sequence, input);
}
