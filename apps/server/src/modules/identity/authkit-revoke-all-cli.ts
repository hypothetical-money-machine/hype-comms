import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { createPool } from "../../db/pool.js";
import { prepareAuthKitRollback } from "./authkit-repository.js";

export const AUTHKIT_REVOKE_ALL_CONFIRMATION = "REVOKE-AUTHKIT-SESSIONS";

const USAGE =
  "Usage: npm run authkit:revoke-all --workspace @hmm-chat/server -- " +
  `--confirm ${AUTHKIT_REVOKE_ALL_CONFIRMATION}`;

export interface AuthKitRevokeAllCliOutput {
  readonly stdout: Pick<NodeJS.WritableStream, "write">;
  readonly stderr: Pick<NodeJS.WritableStream, "write">;
}

export interface AuthKitRevokeAllCliDependencies {
  readonly createDatabasePool?: typeof createPool;
  readonly now?: () => Date;
}

function databaseConfig(env: Readonly<Record<string, string | undefined>>) {
  const databaseUrl = env.HMM_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    throw new Error("HMM_DATABASE_URL is required");
  }
  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("HMM_DATABASE_URL must be a PostgreSQL URL");
  }
  if (parsedDatabaseUrl.protocol !== "postgres:" && parsedDatabaseUrl.protocol !== "postgresql:") {
    throw new Error("HMM_DATABASE_URL must be a PostgreSQL URL");
  }
  const poolSizeResult = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .safeParse(env.HMM_DATABASE_POOL_SIZE ?? 10);
  if (!poolSizeResult.success) {
    throw new Error("HMM_DATABASE_POOL_SIZE must be an integer from 1 through 100");
  }
  return { url: databaseUrl, poolSize: poolSizeResult.data };
}

function requireConfirmation(argv: readonly string[]): void {
  if (argv.length !== 2 || argv[0] !== "--confirm" || argv[1] !== AUTHKIT_REVOKE_ALL_CONFIRMATION) {
    throw new Error(
      `Exact confirmation is required before revoking local AuthKit sessions.\n${USAGE}`,
    );
  }
}

export async function runAuthKitRevokeAllCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: AuthKitRevokeAllCliOutput,
  dependencies: AuthKitRevokeAllCliDependencies = {},
): Promise<number> {
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    // Parse the destructive-action confirmation before configuration or database access.
    requireConfirmation(argv);
    pool = (dependencies.createDatabasePool ?? createPool)(databaseConfig(env));
    const result = await prepareAuthKitRollback(pool, (dependencies.now ?? (() => new Date()))());
    output.stdout.write(`Active AuthKit-created local sessions found: ${String(result.active)}\n`);
    output.stdout.write(`Local AuthKit sessions revoked now: ${String(result.revoked)}\n`);
    output.stdout.write(`Provider session links removed: ${String(result.sessionLinks)}\n`);
    output.stdout.write(
      `AuthKit state purged: transactions=${String(result.transactions)} ` +
        `handoffs=${String(result.handoffs)} events=${String(result.events)}\n`,
    );
    if (result.active !== result.revoked) {
      throw new Error("Not every active AuthKit-created local session was revoked");
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown AuthKit rollback failure";
    output.stderr.write(`AuthKit rollback preparation failed: ${message}\n`);
    return 1;
  } finally {
    await pool?.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  runAuthKitRevokeAllCli(process.argv.slice(2), process.env, {
    stdout: process.stdout,
    stderr: process.stderr,
  })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
