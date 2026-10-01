import type { Pool } from "pg";
import { type ExpiredAttachmentRow } from "./attachment-records.js";
import { runWorkspaceTransaction } from "./transaction.js";
import { type WorkspaceRepositoryHooks } from "./workspace-hooks.js";

const SYNC_RETENTION_DAYS = 90;

const ATTACHMENT_CLEANUP_BATCH_SIZE = 100;

const UNCLAIMED_READY_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface AttachmentCleanupFailure {
  readonly attachmentId: string;
  readonly workspaceId: string;
  readonly error: unknown;
}

/** Owns retention cleanup and retries failed object deletion on later passes. */
export class WorkspaceRetention {
  constructor(
    private readonly pool: Pool,
    private readonly hooks: Pick<WorkspaceRepositoryHooks, "attachmentStore"> = {},
  ) {}
  async deleteExpiredState(): Promise<readonly AttachmentCleanupFailure[]> {
    await this.pool.query(
      `DELETE FROM sync_events
        WHERE created_at < clock_timestamp() - make_interval(days => $1)`,
      [SYNC_RETENTION_DAYS],
    );
    await this.pool.query(
      `DELETE FROM realtime_tickets
        WHERE expires_at < clock_timestamp() - interval '1 hour'`,
    );
    return [
      ...(await this.#deleteExpiredAttachments("pending")),
      ...(await this.#deleteExpiredAttachments("unclaimed-ready")),
    ];
  }

  async #deleteExpiredAttachments(
    kind: "pending" | "unclaimed-ready",
  ): Promise<AttachmentCleanupFailure[]> {
    const store = this.hooks.attachmentStore;
    if (store === undefined) return [];

    const failures: AttachmentCleanupFailure[] = [];

    while (true) {
      const batch = await runWorkspaceTransaction(this.pool, async (client) => {
        const expired =
          kind === "pending"
            ? await client.query<ExpiredAttachmentRow>(
                `SELECT id, workspace_id
                   FROM attachments
                  WHERE status = 'pending'
                    AND upload_expires_at <= clock_timestamp()
                  ORDER BY upload_expires_at, id
                  LIMIT $1
                  FOR UPDATE SKIP LOCKED`,
                [ATTACHMENT_CLEANUP_BATCH_SIZE],
              )
            : await client.query<ExpiredAttachmentRow>(
                `SELECT id, workspace_id
                   FROM attachments
                  WHERE status = 'ready'
                    AND message_id IS NULL
                    AND content_received_at <= clock_timestamp() - make_interval(secs => $1)
                  ORDER BY content_received_at, id
                  LIMIT $2
                  FOR UPDATE SKIP LOCKED`,
                [UNCLAIMED_READY_ATTACHMENT_RETENTION_MS / 1_000, ATTACHMENT_CLEANUP_BATCH_SIZE],
              );
        if (expired.rows.length === 0) {
          return { deleted: 0, selected: 0, failures: [] satisfies AttachmentCleanupFailure[] };
        }

        const deleted: string[] = [];
        const batchFailures: AttachmentCleanupFailure[] = [];
        for (const attachment of expired.rows) {
          try {
            // Keep the row until byte removal succeeds, so a later pass can retry safely.
            await store.remove(attachment.workspace_id, attachment.id);
            deleted.push(attachment.id);
          } catch (error) {
            batchFailures.push({
              attachmentId: attachment.id,
              workspaceId: attachment.workspace_id,
              error,
            });
          }
        }
        if (deleted.length > 0) {
          await client.query("DELETE FROM attachments WHERE id = ANY($1::uuid[])", [deleted]);
        }
        return { deleted: deleted.length, selected: expired.rows.length, failures: batchFailures };
      });
      failures.push(...batch.failures);
      if (batch.selected < ATTACHMENT_CLEANUP_BATCH_SIZE || batch.deleted === 0) {
        return failures;
      }
    }
  }
}
