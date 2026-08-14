import { z } from "zod";

export const AI_CHANNEL_STATE_IPC_MAX_BYTES = 1_048_576;
export const AI_CHANNEL_PROMPT_IPC_MAX_BYTES = 65_536;
export const AI_CHANNEL_PERMISSION_RESPONSE_IPC_MAX_BYTES = 4_096;

const aiChannelIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, "AI Channel identifiers cannot contain padding");
const aiChannelPathSchema = z.string().trim().min(1).max(4_096);
const aiChannelTimestampSchema = z.string().datetime({ offset: true });
export const aiChannelGenerationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const aiChannelStatusSchema = z.enum([
  "unavailable",
  "not-configured",
  "configured",
  "starting",
  "ready",
  "running",
  "error",
]);

export const aiChannelMessageSchema = z
  .object({
    type: z.literal("message"),
    id: aiChannelIdentifierSchema,
    role: z.enum(["user", "assistant", "thought"]),
    body: z.string().max(100_000),
    createdAt: aiChannelTimestampSchema,
  })
  .strict();

export const aiChannelToolKindSchema = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

export const aiChannelToolCallSchema = z
  .object({
    type: z.literal("tool"),
    id: aiChannelIdentifierSchema,
    title: z.string().trim().min(1).max(500),
    kind: aiChannelToolKindSchema,
    status: z.enum(["pending", "in_progress", "completed", "failed"]),
    locations: z.array(aiChannelPathSchema).max(20),
    createdAt: aiChannelTimestampSchema,
  })
  .strict();

export const aiChannelEntrySchema = z.discriminatedUnion("type", [
  aiChannelMessageSchema,
  aiChannelToolCallSchema,
]);

export const aiChannelPermissionOptionSchema = z
  .object({
    id: aiChannelIdentifierSchema,
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
  })
  .strict();

export const aiChannelPermissionRequestSchema = z
  .object({
    id: aiChannelIdentifierSchema,
    toolCallId: aiChannelIdentifierSchema,
    title: z.string().trim().min(1).max(500),
    kind: aiChannelToolKindSchema,
    options: z.array(aiChannelPermissionOptionSchema).min(1).max(8),
  })
  .strict();

export const aiChannelPlanEntrySchema = z
  .object({
    content: z.string().trim().min(1).max(1_000),
    priority: z.enum(["high", "medium", "low"]),
    status: z.enum(["pending", "in_progress", "completed"]),
  })
  .strict();

/**
 * Curated local Claude state exposed to the sandboxed renderer. Raw ACP payloads, credentials,
 * tool input/output, subprocess details, and filesystem contents never cross this boundary.
 */
export const aiChannelStateSchema = z
  .object({
    version: z.literal(1),
    generation: aiChannelGenerationSchema,
    status: aiChannelStatusSchema,
    workspaceName: z.string().trim().min(1).max(255).nullable(),
    entries: z.array(aiChannelEntrySchema).max(200),
    plan: z.array(aiChannelPlanEntrySchema).max(100),
    permissionRequest: aiChannelPermissionRequestSchema.nullable(),
    error: z.string().trim().min(1).max(300).nullable(),
  })
  .strict();

export const aiChannelPromptRequestSchema = z
  .object({
    generation: aiChannelGenerationSchema,
    prompt: z.string().trim().min(1).max(64_000),
  })
  .strict();

export const aiChannelPermissionResponseSchema = z
  .object({
    generation: aiChannelGenerationSchema,
    requestId: aiChannelIdentifierSchema,
    optionId: aiChannelIdentifierSchema,
  })
  .strict();

export const aiChannelGenerationRequestSchema = z
  .object({ generation: aiChannelGenerationSchema })
  .strict();

export type AiChannelStatus = z.infer<typeof aiChannelStatusSchema>;
export type AiChannelMessage = z.infer<typeof aiChannelMessageSchema>;
export type AiChannelToolKind = z.infer<typeof aiChannelToolKindSchema>;
export type AiChannelToolCall = z.infer<typeof aiChannelToolCallSchema>;
export type AiChannelEntry = z.infer<typeof aiChannelEntrySchema>;
export type AiChannelPermissionOption = z.infer<typeof aiChannelPermissionOptionSchema>;
export type AiChannelPermissionRequest = z.infer<typeof aiChannelPermissionRequestSchema>;
export type AiChannelPlanEntry = z.infer<typeof aiChannelPlanEntrySchema>;
export type AiChannelState = z.infer<typeof aiChannelStateSchema>;
export type AiChannelPromptRequest = z.infer<typeof aiChannelPromptRequestSchema>;
export type AiChannelPermissionResponse = z.infer<typeof aiChannelPermissionResponseSchema>;
export type AiChannelGenerationRequest = z.infer<typeof aiChannelGenerationRequestSchema>;
