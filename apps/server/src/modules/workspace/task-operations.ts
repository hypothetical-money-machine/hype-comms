import { readWorkspacePosition } from "./workspace-sequence.js";
import type { SyncPosition } from "@hype-comms/contracts";
import {
  POSTGRES_BIGINT_MAX,
  TASK_PAGE_MAX_LIMIT,
  taskListResponseSchema,
  taskMutationResponseSchema,
  taskRecordListResponseSchema,
  taskRecordMutationResponseSchema,
  taskRecordResponseSchema,
  type CreateTaskRequest,
  type MoveTaskRequest,
  type TaskListFilters,
  type TaskListResponse,
  type TaskMutationResponse,
  type TaskNumber,
  type TaskRecordListResponse,
  type TaskRecordMutationResponse,
  type TaskRecordResponse,
  type UpdateTaskRequest,
} from "@hype-comms/contracts";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { DomainError } from "../../domain-errors.js";
import {
  conversationAudience,
  conversationVisibilitySql,
  requireVisibleChannelBySlug,
  requireVisibleConversation,
} from "./conversation-access.js";
import type { ConversationEventWriter } from "./conversation-events.js";
import { fingerprintApiRequest, runIdempotentMutation } from "./idempotency.js";
import {
  decodeTaskCursor,
  encodeTaskCursor,
  taskFilterHash,
  taskListFilterParameters,
  taskListFilterSql,
} from "./pagination.js";
import type { ConversationRow } from "./records.js";
import { mapTask, mapTaskRecord, type TaskRow } from "./task-records.js";
import { runWorkspaceTransaction } from "./transaction.js";
import type { AuthenticatedTaskIdentity } from "./workspace-identity.js";

const TASK_RANK_STEP = 1_024n;

/** Owns task transactions; query and event helpers receive the same PoolClient. */
export class WorkspaceTaskOperations {
  constructor(
    private readonly pool: Pool,
    private readonly events: ConversationEventWriter,
  ) {}
  async listConversationTasks(
    identity: AuthenticatedTaskIdentity,
    conversationId: string,
    after: string | undefined,
    limit: number,
    filters: TaskListFilters = {},
  ): Promise<TaskListResponse> {
    const filterHash = taskFilterHash(filters);
    const cursor = decodeTaskCursor(after, filterHash);
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), TASK_PAGE_MAX_LIMIT);
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const conversation = await requireVisibleConversation(
          client,
          identity,
          conversationId,
          false,
        );
        this.#requireTaskConversation(identity, conversation);
        const result = await client.query<TaskRow>(
          `SELECT task.*
           FROM tasks AS task
          WHERE task.conversation_id = $1
            AND (
              $2::timestamptz IS NULL
              OR (task.created_at, task.id) < ($2::timestamptz, $3::uuid)
            )
            ${taskListFilterSql("task", 4)}
          ORDER BY task.created_at DESC, task.id DESC
          LIMIT $13`,
          [
            conversationId,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            ...taskListFilterParameters(identity, filters),
            pageLimit + 1,
          ],
        );
        const rows = result.rows.slice(0, pageLimit);
        const last = rows.at(-1);
        const nextCursor =
          result.rows.length > pageLimit && last !== undefined
            ? encodeTaskCursor(last, filterHash)
            : null;
        return taskListResponseSchema.parse({
          snapshotPosition: await readWorkspacePosition(client, identity.currentUser.workspaceId),
          tasks: rows.map(mapTask),
          nextCursor,
          hasMore: nextCursor !== null,
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async listMyTasks(
    identity: AuthenticatedTaskIdentity,
    after: string | undefined,
    limit: number,
    filters: TaskListFilters = {},
  ): Promise<TaskListResponse> {
    const filterHash = taskFilterHash(filters);
    const cursor = decodeTaskCursor(after, filterHash);
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), TASK_PAGE_MAX_LIMIT);
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const result = await client.query<TaskRow>(
          `SELECT task.*
           FROM tasks AS task
           JOIN conversations AS conversation
             ON conversation.id = task.conversation_id
            AND conversation.workspace_id = task.workspace_id
          WHERE task.workspace_id = $1
            AND conversation.is_archived = false
            AND conversation.channel_mode IS DISTINCT FROM 'announcement'
            AND ${conversationVisibilitySql("conversation", "$2")}
            AND (
              task.assignee_id = $2
              OR (
                conversation.kind = 'direct_message'
                AND conversation.dm_user_low_id = $2
                AND conversation.dm_user_high_id = $2
              )
            )
            AND (
              $3::timestamptz IS NULL
              OR (task.created_at, task.id) < ($3::timestamptz, $4::uuid)
            )
            ${taskListFilterSql("task", 5)}
          ORDER BY task.created_at DESC, task.id DESC
          LIMIT $14`,
          [
            identity.currentUser.workspaceId,
            identity.currentUser.user.id,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            ...taskListFilterParameters(identity, filters),
            pageLimit + 1,
          ],
        );
        const rows = result.rows.slice(0, pageLimit);
        const last = rows.at(-1);
        const nextCursor =
          result.rows.length > pageLimit && last !== undefined
            ? encodeTaskCursor(last, filterHash)
            : null;
        return taskListResponseSchema.parse({
          snapshotPosition: await readWorkspacePosition(client, identity.currentUser.workspaceId),
          tasks: rows.map(mapTask),
          nextCursor,
          hasMore: nextCursor !== null,
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async listChannelTasks(
    identity: AuthenticatedTaskIdentity,
    channelSlug: string,
    after: string | undefined,
    limit: number,
    filters: TaskListFilters = {},
  ): Promise<TaskRecordListResponse> {
    const filterHash = taskFilterHash(filters);
    const cursor = decodeTaskCursor(after, filterHash);
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), TASK_PAGE_MAX_LIMIT);
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const conversation = await requireVisibleChannelBySlug(
          client,
          identity,
          channelSlug,
          false,
        );
        this.#requireTaskConversation(identity, conversation);
        const result = await client.query<TaskRow>(
          `SELECT task.*
           FROM tasks AS task
          WHERE task.conversation_id = $1
            AND (
              $2::timestamptz IS NULL
              OR (task.created_at, task.id) < ($2::timestamptz, $3::uuid)
            )
            ${taskListFilterSql("task", 4)}
          ORDER BY task.created_at DESC, task.id DESC
          LIMIT $13`,
          [
            conversation.id,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            ...taskListFilterParameters(identity, filters),
            pageLimit + 1,
          ],
        );
        const rows = result.rows.slice(0, pageLimit);
        const last = rows.at(-1);
        const nextCursor =
          result.rows.length > pageLimit && last !== undefined
            ? encodeTaskCursor(last, filterHash)
            : null;
        return taskRecordListResponseSchema.parse({
          snapshotPosition: await readWorkspacePosition(client, identity.currentUser.workspaceId),
          tasks: rows.map(mapTaskRecord),
          nextCursor,
          hasMore: nextCursor !== null,
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async getTask(identity: AuthenticatedTaskIdentity, taskId: string): Promise<TaskRecordResponse> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<TaskRow>(
        `SELECT task.*
           FROM tasks AS task
           JOIN conversations AS conversation
             ON conversation.id = task.conversation_id
            AND conversation.workspace_id = task.workspace_id
          WHERE task.id = $1
            AND task.workspace_id = $2
            AND ${conversationVisibilitySql("conversation", "$3")}
            AND (
              conversation.kind = 'channel'
              OR (
                conversation.kind = 'direct_message'
                AND conversation.dm_user_low_id = $3
                AND conversation.dm_user_high_id = $3
              )
            )`,
        [taskId, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      const row = result.rows[0];
      if (row === undefined) throw new DomainError("not_found", "Task not found");
      const conversation = await requireVisibleConversation(
        client,
        identity,
        row.conversation_id,
        false,
      );
      this.#requireTaskConversation(identity, conversation);
      return taskRecordResponseSchema.parse({ task: mapTaskRecord(row) });
    } finally {
      client.release();
    }
  }

  async getChannelTaskByNumber(
    identity: AuthenticatedTaskIdentity,
    channelSlug: string,
    taskNumber: TaskNumber,
  ): Promise<TaskRecordResponse> {
    const client = await this.pool.connect();
    try {
      const conversation = await requireVisibleChannelBySlug(client, identity, channelSlug, false);
      this.#requireTaskConversation(identity, conversation);
      const result = await client.query<TaskRow>(
        `SELECT task.*
           FROM tasks AS task
          WHERE task.conversation_id = $1
            AND task.number = $2`,
        [conversation.id, taskNumber],
      );
      const row = result.rows[0];
      if (row === undefined) throw new DomainError("not_found", "Task not found");
      return taskRecordResponseSchema.parse({ task: mapTaskRecord(row) });
    } finally {
      client.release();
    }
  }

  async createTask(
    identity: AuthenticatedTaskIdentity,
    conversationId: string,
    input: CreateTaskRequest,
    idempotencyKey: string,
  ): Promise<TaskMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const conversation = await requireVisibleConversation(
        client,
        identity,
        conversationId,
        true,
        true,
      );
      this.#requireTaskConversation(identity, conversation);
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          workspaceId: identity.currentUser.workspaceId,
          route: `/v1/conversations/${conversationId}/tasks`,
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 201,
          responseSchema: taskMutationResponseSchema,
        },
        async () => {
          await this.#validateTaskReferences(client, identity, conversation, input);
          const numberResult = await client.query<{ next: string } & QueryResultRow>(
            `UPDATE conversations
                SET last_task_number = last_task_number + 1,
                    updated_at = clock_timestamp()
              WHERE id = $1
              RETURNING last_task_number::text AS next`,
            [conversationId],
          );
          const number = numberResult.rows[0]?.next;
          if (number === undefined) throw new Error("Could not allocate task number");
          const rankResult = await client.query<{ next: string } & QueryResultRow>(
            `SELECT (coalesce(max(rank), 0) + $2::bigint)::text AS next
               FROM tasks
              WHERE conversation_id = $1
                AND status = 'todo'`,
            [conversationId, TASK_RANK_STEP.toString()],
          );
          const rank = rankResult.rows[0]?.next;
          if (rank === undefined) throw new Error("Could not allocate task rank");
          const inserted = await client.query<TaskRow>(
            `INSERT INTO tasks (
               id, workspace_id, conversation_id, number, title, description, status,
               priority, assignee_id, due_on, source_message_id, rank, created_by, updated_by
             )
             VALUES ($1, $2, $3, $4, $5, $6, 'todo', $7, $8, $9, $10, $11, $12, $12)
             RETURNING *`,
            [
              randomUUID(),
              identity.currentUser.workspaceId,
              conversationId,
              number,
              input.title,
              input.description,
              input.priority,
              input.assigneeId,
              input.dueOn,
              input.sourceMessageId,
              rank,
              identity.currentUser.user.id,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error("Task insert returned no row");
          const task = mapTask(row);
          const event = await this.events.insert(client, identity, {
            type: "task.created",
            conversation,
            entityVersion: task.version,
            payload: { task },
            audienceUserIds: await conversationAudience(client, conversation),
          });
          return taskMutationResponseSchema.parse({ task, syncCursor: event.position });
        },
      );
    });
  }

  async createChannelTask(
    identity: AuthenticatedTaskIdentity,
    channelSlug: string,
    input: CreateTaskRequest,
    idempotencyKey: string,
  ): Promise<TaskRecordMutationResponse> {
    const conversationId = await this.#visibleChannelIdBySlug(identity, channelSlug, true);
    const created = await this.createTask(identity, conversationId, input, idempotencyKey);
    return taskRecordMutationResponseSchema.parse({
      task: { ...created.task, updatedBy: created.task.createdBy },
      syncCursor: created.syncCursor,
    });
  }

  async updateTask(
    identity: AuthenticatedTaskIdentity,
    taskId: string,
    input: UpdateTaskRequest,
    idempotencyKey: string,
  ): Promise<TaskMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const { conversation, task: current } = await this.#requireTaskTarget(
        client,
        identity,
        taskId,
      );
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          workspaceId: identity.currentUser.workspaceId,
          route: `/v1/tasks/${taskId}`,
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 200,
          responseSchema: taskMutationResponseSchema,
        },
        async () => {
          if (current.version !== input.expectedVersion) {
            throw new DomainError("conflict", "The task changed on another device");
          }
          await this.#validateTaskReferences(client, identity, conversation, input);
          const updated = await client.query<TaskRow>(
            `UPDATE tasks
                SET title = $2,
                    description = $3,
                    priority = $4,
                    assignee_id = $5,
                    due_on = $6,
                    updated_by = $7,
                    version = version + 1,
                    updated_at = clock_timestamp()
              WHERE id = $1
              RETURNING *`,
            [
              taskId,
              input.title,
              input.description,
              input.priority,
              input.assigneeId,
              input.dueOn,
              identity.currentUser.user.id,
            ],
          );
          const row = updated.rows[0];
          if (row === undefined) throw new Error("Task update returned no row");
          const task = mapTask(row);
          const event = await this.events.insert(client, identity, {
            type: "task.updated",
            conversation,
            entityVersion: task.version,
            payload: { task },
            audienceUserIds: await conversationAudience(client, conversation),
          });
          return taskMutationResponseSchema.parse({ task, syncCursor: event.position });
        },
      );
    });
  }

  async moveTask(
    identity: AuthenticatedTaskIdentity,
    taskId: string,
    input: MoveTaskRequest,
    idempotencyKey: string,
  ): Promise<TaskMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const { conversation, task: current } = await this.#requireTaskTarget(
        client,
        identity,
        taskId,
      );
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          workspaceId: identity.currentUser.workspaceId,
          route: `/v1/tasks/${taskId}/move`,
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 200,
          responseSchema: taskMutationResponseSchema,
        },
        async () => {
          if (current.version !== input.expectedVersion) {
            throw new DomainError("conflict", "The task changed on another device");
          }
          const orderedResult = await client.query<TaskRow>(
            `SELECT *
               FROM tasks
              WHERE conversation_id = $1
                AND status = $2
                AND id <> $3
              ORDER BY rank, id
              FOR UPDATE`,
            [conversation.id, input.status, taskId],
          );
          const ordered = orderedResult.rows;
          const insertionIndex =
            input.beforeTaskId === null
              ? ordered.length
              : ordered.findIndex((task) => task.id === input.beforeTaskId);
          if (insertionIndex < 0) {
            throw new DomainError("invalid_input", "The Kanban destination is invalid");
          }
          const previousRank =
            insertionIndex === 0 ? 0n : BigInt(ordered[insertionIndex - 1]?.rank ?? "0");
          const nextRank =
            insertionIndex === ordered.length ? null : BigInt(ordered[insertionIndex]?.rank ?? "0");
          const canAppend =
            nextRank === null && previousRank <= POSTGRES_BIGINT_MAX - TASK_RANK_STEP;
          const hasGap = nextRank !== null && nextRank - previousRank > 1n;
          const changed: TaskRow[] = [];

          if (canAppend || hasGap) {
            const rank = canAppend
              ? previousRank + TASK_RANK_STEP
              : (previousRank + (nextRank ?? previousRank)) / 2n;
            const moved = await client.query<TaskRow>(
              `UPDATE tasks
                  SET status = $2,
                      rank = $3,
                      completed_at = CASE
                        WHEN $2 = 'done' THEN coalesce(completed_at, clock_timestamp())
                        ELSE NULL
                      END,
                      version = version + 1,
                      updated_by = $4,
                      updated_at = clock_timestamp()
                WHERE id = $1
                RETURNING *`,
              [taskId, input.status, rank.toString(), identity.currentUser.user.id],
            );
            const row = moved.rows[0];
            if (row === undefined) throw new Error("Task move returned no row");
            changed.push(row);
          } else {
            const ids = ordered.map((task) => task.id);
            ids.splice(insertionIndex, 0, taskId);
            for (const [index, id] of ids.entries()) {
              const rank = BigInt(index + 1) * TASK_RANK_STEP;
              const updated = await client.query<TaskRow>(
                `UPDATE tasks
                    SET status = CASE WHEN id = $1 THEN $2 ELSE status END,
                        rank = $3,
                        completed_at = CASE
                          WHEN id = $1 AND $2 = 'done' THEN coalesce(completed_at, clock_timestamp())
                          WHEN id = $1 THEN NULL
                          ELSE completed_at
                        END,
                        version = version + 1,
                        updated_by = $5,
                        updated_at = clock_timestamp()
                  WHERE id = $4
                  RETURNING *`,
                [taskId, input.status, rank.toString(), id, identity.currentUser.user.id],
              );
              const row = updated.rows[0];
              if (row === undefined) throw new Error("Task rebalance returned no row");
              changed.push(row);
            }
          }

          const audienceUserIds = await conversationAudience(client, conversation);
          let syncCursor: SyncPosition | null = null;
          for (const row of changed) {
            const task = mapTask(row);
            const event = await this.events.insert(client, identity, {
              type: "task.updated",
              conversation,
              entityVersion: task.version,
              payload: { task },
              audienceUserIds,
            });
            syncCursor = event.position;
          }
          const moved = changed.find((row) => row.id === taskId);
          if (moved === undefined || syncCursor === null)
            throw new Error("Moved task was not returned");
          return taskMutationResponseSchema.parse({ task: mapTask(moved), syncCursor });
        },
      );
    });
  }

  #requireTaskConversation(
    identity: AuthenticatedTaskIdentity,
    conversation: ConversationRow,
  ): void {
    if (conversation.kind === "channel" && conversation.channel_mode === "announcement") {
      throw new DomainError("not_found", "Tasks are not available in this channel");
    }
    if (conversation.kind === "channel") return;
    if (
      identity.principalKind === "human" &&
      conversation.dm_user_low_id === identity.currentUser.user.id &&
      conversation.dm_user_high_id === identity.currentUser.user.id
    ) {
      return;
    }
    throw new DomainError("not_found", "Tasks are available in channels and self messages");
  }

  async #requireTaskTarget(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    taskId: string,
  ): Promise<{ readonly conversation: ConversationRow; readonly task: TaskRow }> {
    const located = await client.query<{ conversation_id: string } & QueryResultRow>(
      `SELECT task.conversation_id
         FROM tasks AS task
         JOIN conversations AS conversation
           ON conversation.id = task.conversation_id
          AND conversation.workspace_id = task.workspace_id
        WHERE task.id = $1
          AND task.workspace_id = $2
          AND ${conversationVisibilitySql("conversation", "$3")}`,
      [taskId, identity.currentUser.workspaceId, identity.currentUser.user.id],
    );
    const conversationId = located.rows[0]?.conversation_id;
    if (conversationId === undefined) throw new DomainError("not_found", "Task not found");
    const conversation = await requireVisibleConversation(
      client,
      identity,
      conversationId,
      true,
      true,
    );
    this.#requireTaskConversation(identity, conversation);
    const taskResult = await client.query<TaskRow>(
      `SELECT * FROM tasks WHERE id = $1 AND conversation_id = $2 FOR UPDATE`,
      [taskId, conversation.id],
    );
    const task = taskResult.rows[0];
    if (task === undefined) throw new DomainError("not_found", "Task not found");
    return { conversation, task };
  }

  async #validateTaskReferences(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    conversation: ConversationRow,
    input: {
      readonly assigneeId: string | null;
      readonly sourceMessageId?: string | null;
    },
  ): Promise<void> {
    if (input.assigneeId !== null) {
      const audience = new Set(await conversationAudience(client, conversation));
      if (!audience.has(input.assigneeId)) {
        throw new DomainError("invalid_input", "The assignee cannot access this task");
      }
    }
    if (input.sourceMessageId !== undefined && input.sourceMessageId !== null) {
      const source = await client.query(
        `SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL`,
        [input.sourceMessageId, conversation.id],
      );
      if (source.rowCount !== 1) {
        throw new DomainError("invalid_input", "The source message is unavailable");
      }
    }
    if (
      conversation.kind === "direct_message" &&
      input.assigneeId !== null &&
      input.assigneeId !== identity.currentUser.user.id
    ) {
      throw new DomainError("invalid_input", "Personal tasks can only be assigned to you");
    }
  }

  async #visibleChannelIdBySlug(
    identity: AuthenticatedTaskIdentity,
    channelSlug: string,
    requireWritable: boolean,
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      return (await requireVisibleChannelBySlug(client, identity, channelSlug, requireWritable)).id;
    } finally {
      client.release();
    }
  }
}
