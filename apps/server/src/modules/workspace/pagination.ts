import { createHash } from "node:crypto";
import { z } from "zod";
import { createCursorCodec, cursorIdSchema, cursorTimestampSchema } from "./cursor-codec.js";
export { UUID_PATTERN } from "./cursor-codec.js";
import type { TaskListFilters } from "@hype-comms/contracts";
import { DomainError } from "../../domain-errors.js";
import { iso } from "./records.js";
import type { TaskRow } from "./task-records.js";
import type { AuthenticatedTaskIdentity } from "./workspace-identity.js";

const taskCursorCodec = createCursorCodec(
  "task",
  z
    .object({
      createdAt: cursorTimestampSchema,
      id: cursorIdSchema,
      filterHash: z.string(),
    })
    .strict(),
);

export function taskFilterHash(filters: TaskListFilters): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        status: filters.status ?? null,
        priority: filters.priority ?? null,
        assignee: filters.assignee ?? null,
        dueAfter: filters.dueAfter ?? null,
        dueBefore: filters.dueBefore ?? null,
        updatedAfter: filters.updatedAfter ?? null,
        updatedBy: filters.updatedBy ?? null,
      }),
    )
    .digest("base64url");
}

export function encodeTaskCursor(row: TaskRow, filterHash: string): string {
  return taskCursorCodec.encode({ createdAt: iso(row.created_at), id: row.id, filterHash });
}

export function decodeTaskCursor(cursor: string | undefined, expectedFilterHash: string) {
  const parsed = taskCursorCodec.decode(cursor);
  if (parsed !== null && parsed.filterHash !== expectedFilterHash)
    throw new DomainError("invalid_input", "Invalid task cursor");
  return parsed;
}

export function taskListFilterParameters(
  identity: AuthenticatedTaskIdentity,
  filters: TaskListFilters,
): readonly unknown[] {
  const assigneeFilter = filters.assignee;
  const assigneeId =
    assigneeFilter === "me"
      ? identity.currentUser.user.id
      : assigneeFilter === "unassigned" || assigneeFilter === undefined
        ? null
        : assigneeFilter;
  const updatedById =
    filters.updatedBy === "me" ? identity.currentUser.user.id : (filters.updatedBy ?? null);
  return [
    filters.status ?? null,
    filters.priority ?? null,
    assigneeFilter !== undefined,
    assigneeFilter === "unassigned",
    assigneeId,
    filters.dueAfter ?? null,
    filters.dueBefore ?? null,
    filters.updatedAfter ?? null,
    updatedById,
  ];
}

export function taskListFilterSql(alias: "task", firstParameter: number): string {
  const parameter = (offset: number) => `$${firstParameter + offset}`;
  return `
    AND (${parameter(0)}::text IS NULL OR ${alias}.status = ${parameter(0)})
    AND (${parameter(1)}::text IS NULL OR ${alias}.priority = ${parameter(1)})
    AND (
      ${parameter(2)}::boolean = false
      OR (${parameter(3)}::boolean = true AND ${alias}.assignee_id IS NULL)
      OR (${parameter(3)}::boolean = false AND ${alias}.assignee_id = ${parameter(4)}::uuid)
    )
    AND (${parameter(5)}::date IS NULL OR ${alias}.due_on >= ${parameter(5)}::date)
    AND (${parameter(6)}::date IS NULL OR ${alias}.due_on <= ${parameter(6)}::date)
    AND (${parameter(7)}::timestamptz IS NULL OR ${alias}.updated_at > ${parameter(7)})
    AND (${parameter(8)}::uuid IS NULL OR ${alias}.updated_by = ${parameter(8)}::uuid)`;
}
