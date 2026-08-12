import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { botAccessTokenSchema, emailSchema } from "@hype-comms/contracts";
import { escapeIdentifier, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { runBotCli, type BotCliOutput } from "../src/modules/bots/cli.js";
import { BotService } from "../src/modules/bots/service.js";
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

  readonly streams: BotCliOutput = {
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

describeWithPostgres("bot CLI", () => {
  const schemaName = `bot_cli_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

  it("creates a usable credential, reports grants, and never repeats the token", async () => {
    await seedOwner();
    const createdOutput = new TestOutput();
    const createExitCode = await runBotCli(
      [
        "create",
        "--username",
        "release-bot",
        "--display-name",
        "Release Bot",
        "--channel",
        "general",
        "--scope",
        "tasks:read",
        "--expires-in-days",
        "30",
      ],
      cliEnv(),
      createdOutput.streams,
    );
    const tokenMatch = /hype_comms_bot_[A-Za-z0-9_-]{43}/.exec(createdOutput.stdout);
    const token = botAccessTokenSchema.parse(tokenMatch?.[0]);

    expect(createExitCode).toBe(0);
    expect(createdOutput.stderr).toBe("");
    await expect(new BotService(pool).authenticate(token)).resolves.toMatchObject({
      principalKind: "bot",
      scopes: ["tasks:read"],
    });

    const listOutput = new TestOutput();
    expect(await runBotCli(["list"], cliEnv(), listOutput.streams)).toBe(0);
    expect(listOutput.stderr).toBe("");
    expect(listOutput.stdout).toContain(
      "@release-bot\tRelease Bot\tcredentials=1\tchannels=general",
    );
    expect(listOutput.stdout).not.toContain(token);
  });

  it("rejects malformed arguments before opening a database connection", async () => {
    const output = new TestOutput();
    const exitCode = await runBotCli(
      ["create", "--username", "Not Valid", "--display-name", "Bot"],
      cliEnv(),
      output.streams,
    );

    expect(exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("--username must be a lowercase hyphenated handle");
  });
});
