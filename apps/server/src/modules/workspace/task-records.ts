import {
  taskSchema,
  taskRecordSchema,
  type Task,
  type TaskRecord,
  type TaskStatus,
} from "@hype-comms/contracts";
import type { QueryResultRow } from "pg";
import { iso, nullableIso } from "./records.js";

export interface TaskRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  number: string;
  version: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Task["priority"];
  assignee_id: string | null;
  due_on: Date | string | null;
  source_message_id: string | null;
  rank: string;
  created_by: string;
  updated_by: string;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function taskDueOn(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function mapTask(row: TaskRow): Task {
  return taskSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    number: row.number,
    version: row.version,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    dueOn: taskDueOn(row.due_on),
    sourceMessageId: row.source_message_id,
    rank: row.rank,
    createdBy: row.created_by,
    completedAt: nullableIso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export function mapTaskRecord(row: TaskRow): TaskRecord {
  return taskRecordSchema.parse({ ...mapTask(row), updatedBy: row.updated_by });
}
