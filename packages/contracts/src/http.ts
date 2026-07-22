import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "CURSOR_EXPIRED",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
]);

export const apiErrorDetailSchema = z
  .object({
    field: z.string().min(1).optional(),
    issue: z.string().min(1),
  })
  .strict();

export const apiErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        message: z.string().min(1),
        requestId: z.string().min(1),
        details: z.array(apiErrorDetailSchema).optional(),
      })
      .strict(),
  })
  .strict();

export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .strict();

export const readinessResponseSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    checks: z.record(z.string(), z.enum(["ok", "failed"])),
  })
  .strict();

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
