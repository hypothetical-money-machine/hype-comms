import { z } from "zod";

import {
  entityIdSchema,
  entityVersionSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  sequenceSchema,
} from "./common.js";
import { realtimeEventEnvelopeSchema } from "./realtime.js";

export const taskStatusSchema = z.enum(["todo", "in_progress", "done"]);
export const taskPrioritySchema = z.enum(["none", "low", "medium", "high", "urgent"]);
export const taskTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((title) => !title.includes("\0"), "Task title cannot contain NUL bytes");
export const taskDescriptionSchema = z
  .string()
  .max(10_000)
  .refine(
    (description) => !description.includes("\0"),
    "Task description cannot contain NUL bytes",
  );
export const taskDueDateSchema = z.iso.date();
export const taskNumberSchema = sequenceSchema.refine(
  (value) => value !== "0",
  "Task number must be positive",
);

export const taskSchema = z
  .object({
    id: entityIdSchema,
    workspaceId: entityIdSchema,
    conversationId: entityIdSchema,
    number: taskNumberSchema,
    version: entityVersionSchema,
    title: taskTitleSchema,
    description: taskDescriptionSchema.nullable(),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    assigneeId: entityIdSchema.nullable(),
    dueOn: taskDueDateSchema.nullable(),
    sourceMessageId: entityIdSchema.nullable(),
    rank: sequenceSchema.refine((value) => value !== "0", "Task rank must be positive"),
    createdBy: entityIdSchema,
    completedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

/** Actor-rich task shape used only by the additive bot-friendly lookup and channel-slug routes. */
export const taskRecordSchema = taskSchema.extend({ updatedBy: entityIdSchema }).strict();

export const TASK_PAGE_DEFAULT_LIMIT = 100;
export const TASK_PAGE_MAX_LIMIT = 200;
export const taskPageCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const taskAssigneeFilterSchema = z.union([
  entityIdSchema,
  z.literal("me"),
  z.literal("unassigned"),
]);
export const taskActorFilterSchema = z.union([entityIdSchema, z.literal("me")]);

export const taskListFiltersSchema = z
  .object({
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    assignee: taskAssigneeFilterSchema.optional(),
    dueAfter: taskDueDateSchema.optional(),
    dueBefore: taskDueDateSchema.optional(),
    updatedAfter: isoDateTimeSchema.optional(),
    updatedBy: taskActorFilterSchema.optional(),
  })
  .strict();

export const taskListQuerySchema = taskListFiltersSchema
  .extend({
    after: taskPageCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(TASK_PAGE_MAX_LIMIT).default(TASK_PAGE_DEFAULT_LIMIT),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.dueAfter !== undefined &&
      value.dueBefore !== undefined &&
      value.dueAfter > value.dueBefore
    ) {
      context.addIssue({
        code: "custom",
        path: ["dueAfter"],
        message: "dueAfter cannot be later than dueBefore",
      });
    }
  });

export const taskListResponseSchema = z
  .object({
    tasks: z.array(taskSchema).max(TASK_PAGE_MAX_LIMIT),
    nextCursor: taskPageCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export const taskRecordListResponseSchema = z
  .object({
    tasks: z.array(taskRecordSchema).max(TASK_PAGE_MAX_LIMIT),
    nextCursor: taskPageCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export const createTaskRequestSchema = z
  .object({
    title: taskTitleSchema,
    description: taskDescriptionSchema.nullable().default(null),
    priority: taskPrioritySchema.default("none"),
    assigneeId: entityIdSchema.nullable().default(null),
    dueOn: taskDueDateSchema.nullable().default(null),
    sourceMessageId: entityIdSchema.nullable().default(null),
  })
  .strict();

export const createTaskOperationSchema = createTaskRequestSchema
  .extend({
    conversationId: entityIdSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const updateTaskRequestSchema = z
  .object({
    expectedVersion: entityVersionSchema,
    title: taskTitleSchema,
    description: taskDescriptionSchema.nullable(),
    priority: taskPrioritySchema,
    assigneeId: entityIdSchema.nullable(),
    dueOn: taskDueDateSchema.nullable(),
  })
  .strict();

export const updateTaskOperationSchema = updateTaskRequestSchema
  .extend({
    taskId: entityIdSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const moveTaskRequestSchema = z
  .object({
    expectedVersion: entityVersionSchema,
    status: taskStatusSchema,
    beforeTaskId: entityIdSchema.nullable(),
  })
  .strict();

export const moveTaskOperationSchema = moveTaskRequestSchema
  .extend({
    taskId: entityIdSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.beforeTaskId === value.taskId) {
      context.addIssue({
        code: "custom",
        path: ["beforeTaskId"],
        message: "A task cannot be moved before itself",
      });
    }
  });

export const taskMutationResponseSchema = z
  .object({
    task: taskSchema,
    syncCursor: sequenceSchema,
  })
  .strict();

export const taskRecordResponseSchema = z.object({ task: taskRecordSchema }).strict();

export const taskRecordMutationResponseSchema = z
  .object({
    task: taskRecordSchema,
    syncCursor: sequenceSchema,
  })
  .strict();

const taskEventBaseSchema = realtimeEventEnvelopeSchema.extend({
  workspaceId: entityIdSchema,
  conversationId: entityIdSchema,
  conversationSequence: z.null(),
  payload: z.object({ task: taskSchema }).strict(),
});

export const taskCreatedEventSchema = taskEventBaseSchema.extend({
  type: z.literal("task.created"),
});

export const taskUpdatedEventSchema = taskEventBaseSchema.extend({
  type: z.literal("task.updated"),
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type TaskNumber = z.infer<typeof taskNumberSchema>;
export type TaskListFilters = z.infer<typeof taskListFiltersSchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;
export type TaskRecordListResponse = z.infer<typeof taskRecordListResponseSchema>;
export type TaskRecordResponse = z.infer<typeof taskRecordResponseSchema>;
export type TaskRecordMutationResponse = z.infer<typeof taskRecordMutationResponseSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type CreateTaskOperation = z.infer<typeof createTaskOperationSchema>;
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
export type UpdateTaskOperation = z.infer<typeof updateTaskOperationSchema>;
export type MoveTaskRequest = z.infer<typeof moveTaskRequestSchema>;
export type MoveTaskOperation = z.infer<typeof moveTaskOperationSchema>;
export type TaskMutationResponse = z.infer<typeof taskMutationResponseSchema>;
export type TaskCreatedEvent = z.infer<typeof taskCreatedEventSchema>;
export type TaskUpdatedEvent = z.infer<typeof taskUpdatedEventSchema>;
