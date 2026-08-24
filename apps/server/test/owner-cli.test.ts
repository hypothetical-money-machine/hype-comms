import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { emailSchema } from "@hype-comms/contracts";
import { escapeIdentifier, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import {
  parseOwnerCommand,
  runOwnerCli,
  type OwnerCliOutput,
} from "../src/modules/identity/owner-cli.js";
import type { EmailSender } from "../src/modules/identity/email.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { SignInThrottle } from "../src/throttle.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

class TestOutput {
  stdout = "";
  stderr = "";

  readonly streams: OwnerCliOutput = {
    stdout: new Writable({
      write: (chunk, _encoding, callback) => {
        this.stdout += chunk.toString();
        callback();
      },
    }),
    stderr: new Writable({
      write: (chunk, _encoding, callback) => {
        this.stderr += chunk.toString();
        callback();
      },
    }),
  };
}

class NullEmailSender implements EmailSender {
  async sendMagicLink(): Promise<void> {}
}

describe("owner CLI argument parsing", () => {
  it("accepts one normalized email target", () => {
    expect(parseOwnerCommand(["promote", "MEMBER@example.com"])).toEqual({
      name: "promote",
      target: { type: "email", value: "member@example.com" },
    });
  });

  it("rejects flags and extra targets", () => {
    expect(() => parseOwnerCommand(["demote", "--email"])).toThrow(
      /A username or email is required/u,
    );
    expect(() => parseOwnerCommand(["promote", "one", "two"])).toThrow(
      /Only one username or email/u,
    );
  });
});

describeWithPostgres("owner CLI", () => {
  const schemaName = `owner_cli_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let databaseUrl: string;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    databaseUrl = schemaScopedUrl(testDatabaseUrl, schemaName);
    pool = createPool({ url: databaseUrl, poolSize: 4 });
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE bot_channel_grants, bot_credentials, workspace_memberships, workspaces, users
      CASCADE
    `);
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  function cliEnv(): Record<string, string> {
    return {
      NODE_ENV: "test",
      HYPE_COMMS_DATABASE_URL: databaseUrl,
      HYPE_COMMS_DATABASE_POOL_SIZE: "4",
      HYPE_COMMS_PUBLIC_API_URL: "http://127.0.0.1:3000",
    };
  }

  async function seedOwner(): Promise<void> {
    const service = new IdentityService(
      new IdentityRepository(pool),
      new NullEmailSender(),
      new SignInThrottle(),
      () => new Date(),
      "http://127.0.0.1:3000",
    );
    await service.seedOwner({
      email: emailSchema.parse("owner@example.com"),
      workspaceName: "Hype Comms",
      workspaceSlug: "hype-comms",
    });
  }

  async function addMember(email: string, username: string): Promise<void> {
    const repository = new IdentityRepository(pool);
    const workspace = await repository.findFirstWorkspace();
    if (workspace === null) throw new Error("Workspace was not seeded");
    const user = await repository.insertUser({
      id: randomUUID(),
      email: emailSchema.parse(email),
      username,
      displayName: username,
      avatarUrl: null,
      title: null,
    });
    await repository.upsertMembership({
      workspaceId: workspace.id,
      userId: user.id,
      role: "member",
      status: "active",
    });
  }

  async function membershipFor(email: string) {
    const repository = new IdentityRepository(pool);
    const user = await repository.findUserByEmail(emailSchema.parse(email));
    if (user === null) throw new Error("Expected user");
    return repository.findActiveMembershipByUserId(user.id);
  }

  it("promotes a member, lists active owners, and accepts username or email", async () => {
    await seedOwner();
    await addMember("member@example.com", "member");
    const promoted = new TestOutput();

    expect(await runOwnerCli(["promote", "MEMBER@example.com"], cliEnv(), promoted.streams)).toBe(
      0,
    );
    expect(promoted.stderr).toBe("");
    expect(promoted.stdout).toContain("Promoted: @member");
    expect(await membershipFor("member@example.com")).toMatchObject({ role: "owner" });

    const listed = new TestOutput();
    expect(await runOwnerCli(["list"], cliEnv(), listed.streams)).toBe(0);
    expect(listed.stdout).toContain("@member\tmember");
    expect(listed.stdout).toContain("@owner\towner");
  });

  it("refuses already-owner, unknown, deactivated, and bot promotion targets distinctly", async () => {
    await seedOwner();
    await addMember("inactive@example.com", "inactive");
    const inactive = await membershipFor("inactive@example.com");
    if (inactive === null) throw new Error("Expected active member");
    await new IdentityRepository(pool).upsertMembership({ ...inactive, status: "revoked" });
    const workspace = await new IdentityRepository(pool).findFirstWorkspace();
    if (workspace === null) throw new Error("Workspace was not seeded");
    const botId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, kind, username, display_name, avatar_url)
       VALUES ($1, NULL, 'bot', 'helper-bot', 'Helper Bot', NULL)`,
      [botId],
    );
    await new IdentityRepository(pool).upsertMembership({
      workspaceId: workspace.id,
      userId: botId,
      role: "member",
      status: "active",
    });

    const cases = [
      [["promote", "owner"], "Member is already an owner"],
      [["promote", "missing"], "No user found for missing"],
      [["promote", "inactive"], "Member is deactivated"],
      [["promote", "helper-bot"], "Bots cannot be workspace owners"],
    ] as const;
    for (const [argv, expected] of cases) {
      const output = new TestOutput();
      expect(await runOwnerCli(argv, cliEnv(), output.streams)).toBe(1);
      expect(output.stdout).toBe("");
      expect(output.stderr).toContain(expected);
    }
  });

  it("demotes an owner but refuses the final active owner", async () => {
    await seedOwner();
    await addMember("member@example.com", "member");
    expect(await runOwnerCli(["promote", "member"], cliEnv(), new TestOutput().streams)).toBe(0);

    const demoted = new TestOutput();
    expect(await runOwnerCli(["demote", "member"], cliEnv(), demoted.streams)).toBe(0);
    expect(demoted.stdout).toContain("Demoted: @member");
    expect(await membershipFor("member@example.com")).toMatchObject({ role: "member" });

    const finalOwner = new TestOutput();
    expect(await runOwnerCli(["demote", "owner"], cliEnv(), finalOwner.streams)).toBe(1);
    expect(finalOwner.stderr).toContain("Cannot demote the last active workspace owner");
    expect(await membershipFor("owner@example.com")).toMatchObject({ role: "owner" });
  });

  it("serializes concurrent demotes of the final two owners", async () => {
    await seedOwner();
    await addMember("first@example.com", "first");
    await addMember("second@example.com", "second");
    expect(await runOwnerCli(["promote", "first"], cliEnv(), new TestOutput().streams)).toBe(0);
    expect(await runOwnerCli(["promote", "second"], cliEnv(), new TestOutput().streams)).toBe(0);
    expect(await runOwnerCli(["demote", "owner"], cliEnv(), new TestOutput().streams)).toBe(0);

    const first = new TestOutput();
    const second = new TestOutput();
    const outcomes = await Promise.all([
      runOwnerCli(["demote", "first"], cliEnv(), first.streams),
      runOwnerCli(["demote", "second"], cliEnv(), second.streams),
    ]);
    const remaining = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM workspace_memberships
        WHERE role = 'owner' AND status = 'active'`,
    );

    expect(outcomes.sort()).toEqual([0, 1]);
    expect(remaining.rows[0]?.count).toBe(1);
    expect([first.stderr, second.stderr].join("\n")).toContain(
      "Cannot demote the last active workspace owner",
    );
  });
});
