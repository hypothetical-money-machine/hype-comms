import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { emailSchema, magicLinkTokenSchema, type Email } from "@hmm-chat/contracts";
import { escapeIdentifier, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import type { EmailSender } from "../src/modules/identity/email.js";
import { runInviteCli, type InviteCliOutput } from "../src/modules/identity/invite-cli.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { SignInThrottle } from "../src/throttle.js";

const testDatabaseUrl = process.env.HMM_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

class TestOutput {
  stdout = "";
  stderr = "";

  readonly streams: InviteCliOutput = {
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

describeWithPostgres("invite CLI", () => {
  const schemaName = `invite_cli_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
      TRUNCATE device_sessions, magic_link_tokens, invitations, workspace_memberships,
               workspaces, users
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
      HMM_DATABASE_URL: databaseUrl,
      HMM_DATABASE_POOL_SIZE: "4",
      HMM_PUBLIC_API_URL: "http://127.0.0.1:3000",
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
      workspaceName: "HMM",
      workspaceSlug: "hmm",
    });
  }

  function magicLinkFrom(output: TestOutput): URL {
    const line = output.stdout.trimEnd().split("\n").at(-1);
    if (line === undefined) throw new Error("CLI did not print a final line");
    return new URL(line);
  }

  it("prints a redeemable magic link for a fresh invitation", async () => {
    await seedOwner();
    const output = new TestOutput();

    const exitCode = await runInviteCli(["--email", "alex@example.com"], cliEnv(), output.streams);
    const token = magicLinkTokenSchema.parse(magicLinkFrom(output).searchParams.get("token"));
    const service = new IdentityService(
      new IdentityRepository(pool),
      new NullEmailSender(),
      new SignInThrottle(),
      () => new Date(),
      "http://127.0.0.1:3000",
    );
    const session = await service.redeemMagicLink(token, "CLI test");

    expect(exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Invited: alex@example.com");
    expect(await service.authenticate(session.token)).toMatchObject({
      email: "alex@example.com",
      role: "member",
    });
  });

  it("reuses an existing pending invitation on a repeated run", async () => {
    await seedOwner();
    const firstOutput = new TestOutput();
    const secondOutput = new TestOutput();

    const firstExitCode = await runInviteCli(
      ["--email", "repeat@example.com", "--role", "member"],
      cliEnv(),
      firstOutput.streams,
    );
    const secondExitCode = await runInviteCli(
      ["--email", "repeat@example.com"],
      cliEnv(),
      secondOutput.streams,
    );
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM invitations WHERE email = $1",
      ["repeat@example.com"],
    );

    expect(firstExitCode).toBe(0);
    expect(secondExitCode).toBe(0);
    expect(secondOutput.stdout).toContain("Existing pending invitation reused.");
    expect(magicLinkFrom(firstOutput).searchParams.get("token")).toBeTruthy();
    expect(magicLinkFrom(secondOutput).searchParams.get("token")).toBeTruthy();
    expect(result.rows[0]?.count).toBe(1);
  });

  it("rejects a malformed email without printing a URL", async () => {
    const output = new TestOutput();

    const exitCode = await runInviteCli(["--email", "not-an-email"], cliEnv(), output.streams);

    expect(exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("Invalid email address");
    expect(output.stderr).not.toContain("/auth/magic-link");
  });

  it("fails clearly when no workspace owner has been seeded", async () => {
    const output = new TestOutput();

    const exitCode = await runInviteCli(
      ["--email", emailSchema.parse("alex@example.com") satisfies Email],
      cliEnv(),
      output.streams,
    );

    expect(exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("Set HMM_OWNER_EMAIL and start the server once");
  });
});
