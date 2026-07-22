import { z } from "zod";

export const entityIdSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime();
export const sequenceSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/, "Expected an unsigned base-10 integer string");
export const entityVersionSchema = z.number().int().positive();
export const credentialFreeHttpsUrlSchema = z
  .url({ protocol: /^https$/ })
  .refine((value) => !/^https:\/\/[^/?#]*@/i.test(value), "Expected a credential-free HTTPS URL");

const operationKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const clientMessageIdSchema = entityIdSchema;
export const idempotencyKeySchema = operationKeySchema;

export type EntityId = z.infer<typeof entityIdSchema>;
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;
export type Sequence = z.infer<typeof sequenceSchema>;
export type EntityVersion = z.infer<typeof entityVersionSchema>;
export type ClientMessageId = z.infer<typeof clientMessageIdSchema>;
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;
