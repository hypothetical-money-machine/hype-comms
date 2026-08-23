import path from "node:path";
import { pathToFileURL } from "node:url";

import { emailSchema, userSchema, type Email, type EntityId } from "@hype-comms/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { loadConfig } from "../../config.js";
import { runMigrations } from "../../db/migrate.js";
import { createPool, withTransaction } from "../../db/pool.js";
import { IdentityRepository } from "./repository.js";

const USAGE = `Usage:
  npm run owner --workspace @hype-comms/server -- promote <username-or-email>
  npm run owner --workspace @hype-comms/server -- demote <username-or-email>
  npm run owner --workspace @hype-comms/server -- list`;

export interface OwnerCliOutput {
  readonly stdout: Pick<NodeJS.WritableStream, "write">;
  readonly stderr: Pick<NodeJS.WritableStream, "write">;
}

export type OwnerTarget =
  | { readonly type: "email"; readonly value: Email }
  | { readonly type: "username"; readonly value: string };

export type OwnerCommand =
  | { readonly name: "promote"; readonly target: OwnerTarget }
  | { readonly name: "demote"; readonly target: OwnerTarget }
  | { readonly name: "list" };

interface TargetUserRow extends QueryResultRow {
  readonly id: unknown;
  readonly kind: unknown;
  readonly username: unknown;
  readonly display_name: unknown;
}

interface MembershipRow extends QueryResultRow {
  readonly role: unknown;
  readonly status: unknown;
}

interface OwnerRow extends QueryResultRow {
  readonly id: unknown;
  readonly username: unknown;
  readonly display_name: unknown;
}

interface CountRow extends QueryResultRow {
  readonly count: unknown;
}

export interface OwnerChange {
  readonly userId: EntityId;
  readonly username: string;
  readonly displayName: string;
  readonly role: "owner" | "member";
}

function parseTarget(value: string | undefined): OwnerTarget {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`A username or email is required\n${USAGE}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`A username or email is required\n${USAGE}`);
  if (trimmed.includes("@")) {
    const parsed = emailSchema.safeParse(trimmed);
    if (!parsed.success) throw new Error(`Invalid email address\n${USAGE}`);
    return { type: "email", value: parsed.data };
  }
  const parsed = userSchema.shape.username.safeParse(trimmed);
  if (!parsed.success) throw new Error(`Invalid username\n${USAGE}`);
  return { type: "username", value: parsed.data };
}

export function parseOwnerCommand(argv: readonly string[]): OwnerCommand {
  const [name, target, ...extra] = argv;
  if (name === "list") {
    if (target !== undefined) throw new Error(`list does not accept arguments\n${USAGE}`);
    return { name };
  }
  if (name !== "promote" && name !== "demote") {
    throw new Error(`An owner command is required\n${USAGE}`);
  }
  if (extra.length !== 0) throw new Error(`Only one username or email may be specified\n${USAGE}`);
  return { name, target: parseTarget(target) };
}

function targetClause(target: OwnerTarget): { readonly sql: string; readonly value: string } {
  return target.type === "email"
    ? { sql: "user_account.email = $1", value: target.value }
    : { sql: "user_account.username = $1", value: target.value };
}

function targetDescription(target: OwnerTarget): string {
  return target.value;
}

async function requireTargetUser(client: PoolClient, target: OwnerTarget): Promise<OwnerChange> {
  const clause = targetClause(target);
  const result = await client.query<TargetUserRow>(
    `SELECT user_account.id,
            user_account.kind,
            user_account.username,
            user_account.display_name
       FROM users AS user_account
      WHERE ${clause.sql}
      FOR UPDATE`,
    [clause.value],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`No user found for ${targetDescription(target)}`);
  if (typeof row.id !== "string") throw new TypeError("Expected a user id from Postgres");
  if (typeof row.username !== "string" || typeof row.display_name !== "string") {
    throw new TypeError("Expected user details from Postgres");
  }
  if (row.kind === "bot") throw new Error("Bots cannot be workspace owners");
  if (row.kind === "agent") throw new Error("Agents cannot be workspace owners");
  if (row.kind !== "human") throw new TypeError("Expected a recognized user kind from Postgres");
  return {
    userId: row.id as EntityId,
    username: row.username,
    displayName: row.display_name,
    role: "member",
  };
}

async function requireMembership(
  client: PoolClient,
  workspaceId: EntityId,
  target: OwnerChange,
): Promise<"owner" | "member"> {
  const result = await client.query<MembershipRow>(
    `SELECT role, status
       FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2
      FOR UPDATE`,
    [workspaceId, target.userId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("User is not a member of this workspace");
  if (row.status !== "active") throw new Error("Member is deactivated");
  if (row.role !== "owner" && row.role !== "member") {
    throw new TypeError("Expected a recognized workspace role from Postgres");
  }
  return row.role;
}

async function changeOwnerRole(
  pool: Pool,
  workspaceId: EntityId,
  targetInput: OwnerTarget,
  command: "promote" | "demote",
): Promise<OwnerChange> {
  return withTransaction(pool, async (client) => {
    const target = await requireTargetUser(client, targetInput);
    const currentRole = await requireMembership(client, workspaceId, target);
    // Membership mutations elsewhere lock a membership before the workspace. Keep that global
    // order, then use the workspace row to serialize the active-owner count and role update.
    // A concurrent demote waits here and re-counts after the first transaction commits, so it
    // cannot remove both of the final two owners.
    const workspace = await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [
      workspaceId,
    ]);
    if (workspace.rowCount !== 1) throw new Error("Workspace not found");
    if (command === "promote") {
      if (currentRole === "owner") throw new Error("Member is already an owner");
      await client.query(
        `UPDATE workspace_memberships
            SET role = 'owner', updated_at = now()
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, target.userId],
      );
      return { ...target, role: "owner" };
    }

    if (currentRole !== "owner") throw new Error("Member is not an owner");
    const count = await client.query<CountRow>(
      `SELECT count(*)::integer AS count
         FROM workspace_memberships
        WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'`,
      [workspaceId],
    );
    const activeOwners = count.rows[0]?.count;
    if (typeof activeOwners !== "number") throw new TypeError("Expected active-owner count");
    if (activeOwners <= 1) throw new Error("Cannot demote the last active workspace owner");
    await client.query(
      `UPDATE workspace_memberships
          SET role = 'member', updated_at = now()
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, target.userId],
    );
    return { ...target, role: "member" };
  });
}

async function listOwners(pool: Pool, workspaceId: EntityId): Promise<readonly OwnerChange[]> {
  const result = await pool.query<OwnerRow>(
    `SELECT user_account.id,
            user_account.username,
            user_account.display_name
       FROM workspace_memberships AS membership
       JOIN users AS user_account ON user_account.id = membership.user_id
      WHERE membership.workspace_id = $1
        AND membership.role = 'owner'
        AND membership.status = 'active'
      ORDER BY lower(user_account.display_name), user_account.id`,
    [workspaceId],
  );
  return result.rows.map((row) => {
    if (typeof row.id !== "string") throw new TypeError("Expected a user id from Postgres");
    if (typeof row.username !== "string" || typeof row.display_name !== "string") {
      throw new TypeError("Expected user details from Postgres");
    }
    return {
      userId: row.id as EntityId,
      username: row.username,
      displayName: row.display_name,
      role: "owner",
    };
  });
}

function writeAudit(
  command: "promote" | "demote",
  workspaceId: EntityId,
  change: OwnerChange,
): void {
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      event: command === "promote" ? "workspace_owner_promoted" : "workspace_owner_demoted",
      workspaceId,
      targetUserId: change.userId,
      targetUsername: change.username,
    })}\n`,
  );
}

export async function runOwnerCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: OwnerCliOutput,
): Promise<number> {
  let pool: Pool | undefined;
  try {
    if (env.HYPE_COMMS_DATABASE_URL === undefined || env.HYPE_COMMS_DATABASE_URL === "") {
      throw new Error("HYPE_COMMS_DATABASE_URL is required");
    }
    const command = parseOwnerCommand(argv);
    const config = loadConfig(env);
    if (config.database === undefined) throw new Error("HYPE_COMMS_DATABASE_URL is required");
    pool = createPool(config.database);
    await runMigrations(pool);
    const workspace = await new IdentityRepository(pool).findFirstWorkspace();
    const owner =
      workspace === null
        ? null
        : await new IdentityRepository(pool).findActiveOwnerMembership(workspace.id);
    if (workspace === null || owner === null) {
      throw new Error(
        "No seeded workspace owner was found. Set HYPE_COMMS_OWNER_EMAIL and start the server once to seed it.",
      );
    }

    if (command.name === "list") {
      const owners = await listOwners(pool, workspace.id);
      if (owners.length === 0) {
        output.stdout.write("No active owners.\n");
      } else {
        for (const owner of owners) {
          output.stdout.write(`@${owner.username}\t${owner.displayName}\n`);
        }
      }
      return 0;
    }

    const change = await changeOwnerRole(pool, workspace.id, command.target, command.name);
    output.stdout.write(
      `${command.name === "promote" ? "Promoted" : "Demoted"}: @${change.username}\n`,
    );
    output.stdout.write(`Role: ${change.role}\n`);
    writeAudit(command.name, workspace.id, change);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown owner-management failure";
    output.stderr.write(`Owner command failed: ${message}\n`);
    return 1;
  } finally {
    await pool?.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  runOwnerCli(process.argv.slice(2), process.env, {
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
