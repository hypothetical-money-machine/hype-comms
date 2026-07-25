import { z } from "zod";

import { entityIdSchema } from "./common.js";
import { sendMessageResponseSchema, syncResponseSchema } from "./workspace.js";

const base64UrlSchema = z
  .string()
  .min(1)
  .max(128 * 1_024)
  .regex(/^[A-Za-z0-9_-]+$/);

export const cacheStoreSchema = z.enum([
  "workspace",
  "member",
  "conversation",
  "message",
  "read_cursor",
  "outbox",
]);

export const cacheRecordContextSchema = z
  .object({
    store: cacheStoreSchema,
    recordId: z.string().min(1).max(128),
    schemaVersion: z.literal(1),
  })
  .strict();

export const cacheCiphertextSchema = z
  .object({
    version: z.literal(1),
    keyVersion: z.literal(1),
    schemaVersion: z.literal(1),
    nonce: z
      .string()
      .length(16)
      .regex(/^[A-Za-z0-9_-]+$/),
    ciphertext: base64UrlSchema,
  })
  .strict();

export const cacheEncryptBatchRequestSchema = z
  .object({
    items: z
      .array(
        cacheRecordContextSchema
          .extend({
            plaintext: z.string().max(64 * 1_024),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();

export const cacheEncryptBatchResponseSchema = z
  .object({
    items: z
      .array(
        cacheRecordContextSchema
          .extend({
            value: cacheCiphertextSchema,
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();

export const cacheDecryptBatchRequestSchema = cacheEncryptBatchResponseSchema;

export const cacheDecryptBatchResponseSchema = z
  .object({
    items: z
      .array(
        cacheRecordContextSchema
          .extend({
            plaintext: z.string().max(64 * 1_024),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();

export const cacheScopeSchema = z
  .object({
    userId: entityIdSchema,
    workspaceId: entityIdSchema,
  })
  .strict();

export const cacheCryptoStatusSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("persistent"),
      scope: cacheScopeSchema,
      keyVersion: z.literal(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("memory_only"),
      scope: cacheScopeSchema,
      reason: z.enum(["credential_store_unavailable", "key_unavailable"]),
    })
    .strict(),
]);

export const sendAttemptResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("accepted"),
      response: sendMessageResponseSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("retryable"),
      reason: z.enum(["network", "rate_limited", "server", "invalid_response"]),
      retryAfterMs: z.number().int().nonnegative().max(86_400_000).nullable(),
    })
    .strict(),
  z.object({ status: z.literal("authentication_required") }).strict(),
  z
    .object({
      status: z.literal("permanent"),
      reason: z.enum(["validation", "forbidden", "not_found", "conflict"]),
    })
    .strict(),
]);

export const syncAttemptResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), response: syncResponseSchema }).strict(),
  z
    .object({
      status: z.literal("reset_required"),
      reason: z.enum(["cursor_expired", "server_reset"]),
    })
    .strict(),
  z.object({ status: z.literal("retryable") }).strict(),
  z.object({ status: z.literal("authentication_required") }).strict(),
]);

export type CacheStore = z.infer<typeof cacheStoreSchema>;
export type CacheRecordContext = z.infer<typeof cacheRecordContextSchema>;
export type CacheCiphertext = z.infer<typeof cacheCiphertextSchema>;
export type CacheEncryptBatchRequest = z.infer<typeof cacheEncryptBatchRequestSchema>;
export type CacheEncryptBatchResponse = z.infer<typeof cacheEncryptBatchResponseSchema>;
export type CacheDecryptBatchRequest = z.infer<typeof cacheDecryptBatchRequestSchema>;
export type CacheDecryptBatchResponse = z.infer<typeof cacheDecryptBatchResponseSchema>;
export type CacheScope = z.infer<typeof cacheScopeSchema>;
export type CacheCryptoStatus = z.infer<typeof cacheCryptoStatusSchema>;
export type SendAttemptResult = z.infer<typeof sendAttemptResultSchema>;
export type SyncAttemptResult = z.infer<typeof syncAttemptResultSchema>;
