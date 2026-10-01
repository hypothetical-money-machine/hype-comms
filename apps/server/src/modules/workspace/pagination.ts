import { createHash } from "node:crypto";
import type { TaskListFilters } from "@hype-comms/contracts";
import { DomainError } from "../../domain-errors.js";
import { iso } from "./records.js";
import type { TaskRow } from "./task-records.js";
import type { AuthenticatedTaskIdentity } from "./workspace-identity.js";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TaskCursor {
  readonly createdAt: string;
  readonly id: string;
  readonly filterHash: string;
}

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

const EMPTY_TASK_FILTER_HASH = taskFilterHash({});

export function encodeTaskCursor(row: TaskRow, filterHash: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: iso(row.created_at), id: row.id, filterHash } satisfies TaskCursor),
    "utf8",
  ).toString("base64url");
}

export function decodeTaskCursor(
  cursor: string | undefined,
  expectedFilterHash: string,
): TaskCursor | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("createdAt" in parsed) ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id) ||
      ("filterHash" in parsed &&
        (typeof parsed.filterHash !== "string" || parsed.filterHash !== expectedFilterHash)) ||
      (!("filterHash" in parsed) && expectedFilterHash !== EMPTY_TASK_FILTER_HASH)
    ) {
      throw new Error("Invalid cursor");
    }
    return {
      createdAt: new Date(parsed.createdAt).toISOString(),
      id: parsed.id,
      filterHash: expectedFilterHash,
    };
  } catch {
    throw new DomainError("invalid_input", "Invalid task cursor");
  }
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
