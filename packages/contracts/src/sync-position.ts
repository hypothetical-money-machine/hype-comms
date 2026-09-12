import { z } from "zod";

import { entityIdSchema, sequenceSchema } from "./common.js";

/** A sequence belongs to one durable workspace replay epoch, never to a client connection. */
export const syncPositionSchema = z
  .object({ epoch: entityIdSchema, sequence: sequenceSchema })
  .strict()
  .readonly();

export type SyncPosition = z.infer<typeof syncPositionSchema>;

export function sameSyncPosition(left: SyncPosition, right: SyncPosition): boolean {
  return left.epoch === right.epoch && left.sequence === right.sequence;
}

/** Epochs have no ordering. A different epoch requires an authoritative bootstrap. */
export function compareSyncPositions(left: SyncPosition, right: SyncPosition): -1 | 0 | 1 {
  if (left.epoch !== right.epoch) throw new Error("Sync positions belong to different epochs");
  const a = BigInt(left.sequence);
  const b = BigInt(right.sequence);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON keeps the same position shape in HTTP queries, CLI cursor files, and realtime URLs. */
export const syncPositionQuerySchema = z
  .string()
  .max(128)
  .transform((value, context) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      context.addIssue({ code: "custom", message: "Expected a JSON sync position" });
      return z.NEVER;
    }
    const result = syncPositionSchema.safeParse(parsed);
    if (!result.success) {
      context.addIssue({ code: "custom", message: "Expected an epoch and sequence" });
      return z.NEVER;
    }
    return result.data;
  });

export function encodeSyncPosition(position: SyncPosition): string {
  return JSON.stringify(syncPositionSchema.parse(position));
}
