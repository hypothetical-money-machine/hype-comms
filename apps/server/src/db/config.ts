import { z } from "zod";

export const databaseUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "postgres:" || protocol === "postgresql:";
}, "Expected a PostgreSQL URL");
export const databasePoolSizeSchema = z.coerce.number().int().min(1).max(100).default(10);

/** Database-only commands must not depend on unrelated email or provider configuration. */
export function loadDatabaseConfig(env: Readonly<Record<string, string | undefined>>) {
  const rawUrl = env.HYPE_COMMS_DATABASE_URL;
  if (rawUrl === undefined || rawUrl.trim() === "")
    throw new Error("HYPE_COMMS_DATABASE_URL is required");
  const url = databaseUrlSchema.safeParse(rawUrl);
  if (!url.success) throw new Error("HYPE_COMMS_DATABASE_URL must be a PostgreSQL URL");
  const poolSize = databasePoolSizeSchema.safeParse(env.HYPE_COMMS_DATABASE_POOL_SIZE);
  if (!poolSize.success)
    throw new Error("HYPE_COMMS_DATABASE_POOL_SIZE must be an integer from 1 through 100");
  return { url: url.data, poolSize: poolSize.data };
}
