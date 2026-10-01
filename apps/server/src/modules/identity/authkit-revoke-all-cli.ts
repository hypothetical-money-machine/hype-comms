import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadDatabaseConfig } from "../../db/config.js";
import { parseAdminArguments } from "../../cli/arguments.js";

import { createPool } from "../../db/pool.js";
import { prepareAuthKitRollback } from "./authkit-repository.js";

export const AUTHKIT_REVOKE_ALL_CONFIRMATION = "REVOKE-AUTHKIT-SESSIONS";

const USAGE =
  "Usage: npm run authkit:revoke-all --workspace @hype-comms/server -- " +
  `--confirm ${AUTHKIT_REVOKE_ALL_CONFIRMATION}`;

export interface AuthKitRevokeAllCliOutput {
  readonly stdout: Pick<NodeJS.WritableStream, "write">;
  readonly stderr: Pick<NodeJS.WritableStream, "write">;
}

export interface AuthKitRevokeAllCliDependencies {
  readonly createDatabasePool?: typeof createPool;
  readonly now?: () => Date;
}

function requireConfirmation(argv: readonly string[]): void {
  try {
    const { values } = parseAdminArguments(argv, { confirm: { type: "string" } }, USAGE);
    if (values.confirm === AUTHKIT_REVOKE_ALL_CONFIRMATION) return;
  } catch {
    // Invalid syntax must still explain the required destructive-action confirmation.
  }
  throw new Error(
    `Exact confirmation is required before revoking local AuthKit sessions.\n${USAGE}`,
  );
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
    pool = (dependencies.createDatabasePool ?? createPool)(loadDatabaseConfig(env));
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
