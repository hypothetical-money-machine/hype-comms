import { paginationCursorSchema } from "@hype-comms/contracts";
import { z } from "zod";

import { DomainError } from "../../domain-errors.js";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const cursorIdSchema = z.string().regex(UUID_PATTERN);
export const cursorTimestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)))
  .transform((value) => new Date(value).toISOString());

/** Cursors are bounded opaque JSON. Missing starts a page; malformed always means invalid input. */
export function createCursorCodec<Value>(name: string, schema: z.ZodType<Value>) {
  return {
    encode(value: Value): string {
      return paginationCursorSchema.parse(
        Buffer.from(JSON.stringify(schema.parse(value)), "utf8").toString("base64url"),
      );
    },
    decode(cursor: string | undefined): Value | null {
      if (cursor === undefined) return null;
      try {
        paginationCursorSchema.parse(cursor);
        const bytes = Buffer.from(cursor, "base64url");
        if (bytes.toString("base64url") !== cursor) throw new Error("Noncanonical cursor encoding");
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return schema.parse(JSON.parse(source) as unknown);
      } catch {
        throw new DomainError("invalid_input", `Invalid ${name} cursor`);
      }
    },
  };
}
