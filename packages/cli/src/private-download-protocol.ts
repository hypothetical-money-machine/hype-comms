import { isAbsolute, parse } from "node:path";

import { z } from "zod";

export const PRIVATE_DOWNLOAD_MAX_CONFIG_BYTES = 1 * 1_024 * 1_024;
export const PRIVATE_DOWNLOAD_MAX_INPUT_BYTES = 25 * 1_024 * 1_024;
export const PRIVATE_DOWNLOAD_MAX_SNAPSHOT_COMPONENTS = 16_384;
export const PRIVATE_DOWNLOAD_MAX_FAILURE_MESSAGE_LENGTH = 1_024;
export const PRIVATE_DOWNLOAD_INVALID_OUTPUT_PATH_MESSAGE =
  "The output directory changed while the file was being saved";
export const PRIVATE_DOWNLOAD_OUTPUT_EXISTS_MESSAGE = "The output path already exists";

const privateDownloadIdentitySchema = z.string().regex(/^(0|[1-9]\d*)$/);
const privateDownloadFileNameSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value !== "." && value !== ".." && !value.includes("\0") && parse(value).base === value,
  );

const privateDownloadDirectoryRootSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0") && isAbsolute(value)),
    dev: privateDownloadIdentitySchema,
    ino: privateDownloadIdentitySchema,
  })
  .strict();

const privateDownloadDirectoryComponentSchema = z
  .object({
    name: privateDownloadFileNameSchema,
    dev: privateDownloadIdentitySchema,
    ino: privateDownloadIdentitySchema,
  })
  .strict();

const privateDownloadDirectorySnapshotSchema = z
  .object({
    root: privateDownloadDirectoryRootSchema,
    components: z
      .array(privateDownloadDirectoryComponentSchema)
      .max(PRIVATE_DOWNLOAD_MAX_SNAPSHOT_COMPONENTS),
  })
  .strict();

const privateDownloadWorkerConfigSchema = z
  .object({
    byteLength: z.number().int().nonnegative().max(PRIVATE_DOWNLOAD_MAX_INPUT_BYTES),
    directorySnapshot: privateDownloadDirectorySnapshotSchema,
    targetName: privateDownloadFileNameSchema,
    temporaryName: privateDownloadFileNameSchema,
  })
  .strict();

export const privateDownloadConfigMessageSchema = z
  .object({
    type: z.literal("config"),
    config: privateDownloadWorkerConfigSchema,
  })
  .strict();

export const privateDownloadPhaseSchema = z.enum(["temporary-ready", "target-linked"]);

export const privateDownloadPhaseMessageSchema = z
  .object({
    type: z.literal("phase"),
    phase: privateDownloadPhaseSchema,
  })
  .strict();

export const privateDownloadContinuationMessageSchema = z
  .object({
    type: z.literal("continue"),
    phase: privateDownloadPhaseSchema,
  })
  .strict();

export const privateDownloadSuccessMessageSchema = z
  .object({
    type: z.literal("result"),
    ok: z.literal(true),
  })
  .strict();

export const privateDownloadFailureCodeSchema = z.enum([
  "INVALID_OUTPUT_PATH",
  "OUTPUT_EXISTS",
  "WORKER_FAILURE",
]);

export const privateDownloadFailureMessageSchema = z
  .object({
    type: z.literal("result"),
    ok: z.literal(false),
    code: privateDownloadFailureCodeSchema,
    message: z.string().min(1).max(PRIVATE_DOWNLOAD_MAX_FAILURE_MESSAGE_LENGTH),
  })
  .strict();

export const privateDownloadResultMessageSchema = z.discriminatedUnion("ok", [
  privateDownloadSuccessMessageSchema,
  privateDownloadFailureMessageSchema,
]);

export const privateDownloadWorkerMessageSchema = z.union([
  privateDownloadPhaseMessageSchema,
  privateDownloadResultMessageSchema,
]);

export type PrivateDownloadContinuationMessage = z.infer<
  typeof privateDownloadContinuationMessageSchema
>;
export type PrivateDownloadFailureCode = z.infer<typeof privateDownloadFailureCodeSchema>;
export type PrivateDownloadPhase = z.infer<typeof privateDownloadPhaseSchema>;
export type PrivateDownloadPhaseMessage = z.infer<typeof privateDownloadPhaseMessageSchema>;
export type PrivateDownloadResultMessage = z.infer<typeof privateDownloadResultMessageSchema>;
