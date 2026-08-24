import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import {
  DEFAULT_AGENCY_AGENT_SCOPES,
  DEFAULT_AGENT_SCOPES,
  agentCurrentPrincipalSchema,
  agentEnrollmentResponseSchema,
  entityIdSchema,
  idempotencyKeySchema,
  listAgentTokensResponseSchema,
  redeemAgentEnrollmentResponseSchema,
  requestAgentEnrollmentSchema,
} from "@hype-comms/contracts";
import { escapeIdentifier, type Pool, type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { executeCli } from "../../../packages/cli/src/cli.js";
import { loadProfileStore, saveProfile } from "../../../packages/cli/src/config.js";
import {
  EXIT_AUTH,
  EXIT_SUCCESS,
  EXIT_TRANSIENT,
  type CliExitCode,
} from "../../../packages/cli/src/errors.js";
import type { Runtime } from "../../../packages/cli/src/types.js";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { AgentEnrollmentModule } from "../src/modules/identity/agent-enrollment.js";
import type { EmailSender } from "../src/modules/identity/email.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { hashToken } from "../src/modules/identity/tokens.js";
import { SignInThrottle } from "../src/throttle.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const ownerId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const ownerSessionId = "10000000-0000-4000-8000-000000000003";
const ownerSessionToken = "o".repeat(43);
const now = new Date("2026-08-23T12:00:00.000Z");

interface CliRun {
  readonly argv: readonly string[];
  readonly exitCode: CliExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

interface EnrollmentTokenRow extends QueryResultRow {
  readonly token_hash: Buffer;
  readonly scopes: string[];
}

interface RevokedTokenRow extends QueryResultRow {
  readonly revoked_at: Date | null;
}

class NoopEmailSender implements EmailSender {
  async sendMagicLink(): Promise<void> {}
}

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

function environment(homeDirectory: string, profile: string): NodeJS.ProcessEnv {
  return {
    HYPE_COMMS_CONFIG_DIR: path.join(homeDirectory, "config"),
    HYPE_COMMS_PROFILE: profile,
  };
}

function runtime(
  homeDirectory: string,
  profile: string,
): Runtime & { readonly stdoutText: () => string; readonly stderrText: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutContent = "";
  let stderrContent = "";
  stdout.on("data", (chunk: Buffer) => {
    stdoutContent += chunk.toString("utf8");
  });
  stderr.on("data", (chunk: Buffer) => {
    stderrContent += chunk.toString("utf8");
  });
  return {
    env: environment(homeDirectory, profile),
    cwd: homeDirectory,
    homeDirectory,
    fetch: globalThis.fetch,
    io: {
      stdin: Readable.from(""),
      stdout,
      stderr,
      stdinIsTty: false,
    },
    now: Date.now,
    random: () => 0,
    stdoutText: () => stdoutContent,
    stderrText: () => stderrContent,
  };
}

const offerOutputSchema = z
  .object({
    profile: z.string(),
    apiOrigin: z.string(),
    request: requestAgentEnrollmentSchema,
  })
  .strict();
const requestOutputSchema = agentEnrollmentResponseSchema.extend({
  idempotencyKey: idempotencyKeySchema,
});
const redeemOutputSchema = redeemAgentEnrollmentResponseSchema.extend({
  principal: agentCurrentPrincipalSchema,
  profile: z.string(),
  saved: z.literal(true),
});
const tokenListOutputSchema = listAgentTokensResponseSchema.extend({ agentId: entityIdSchema });
const revokeOutputSchema = z.object({ agentId: entityIdSchema, revoked: entityIdSchema }).strict();
const cliErrorOutputSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        httpStatus: z.number().int().nullable(),
      })
      .passthrough(),
  })
  .strict();

describeWithPostgres("zero-copy Atlas enrollment through the listening CLI/API boundary", () => {
  const schemaName = `agent_cli_e2e_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const temporaryDirectories: string[] = [];
  let adminPool: Pool;
  let pool: Pool;
  let identityService: IdentityService;
  let enrollment: AgentEnrollmentModule;
  let listeningApp: Awaited<ReturnType<typeof buildApp>> | undefined;

  async function temporaryHome(label: string): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), `hype-comms-${label}-`));
    temporaryDirectories.push(directory);
    return directory;
  }

  async function run(
    runs: CliRun[],
    homeDirectory: string,
    profile: string,
    argv: readonly string[],
  ): Promise<CliRun> {
    const commandRuntime = runtime(homeDirectory, profile);
    const runResult: CliRun = {
      argv: [...argv],
      exitCode: await executeCli(argv, commandRuntime),
      stdout: commandRuntime.stdoutText(),
      stderr: commandRuntime.stderrText(),
    };
    runs.push(runResult);
    return runResult;
  }

  async function startServer(agentProvisioningEnabled: boolean, port = 0): Promise<string> {
    listeningApp = await buildApp({
      cookieSecure: false,
      identity: {
        service: identityService,
        agentEnrollment: enrollment,
        agentProvisioningEnabled,
      },
    });
    return listeningApp.listen({ host: "127.0.0.1", port });
  }

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 8 });
    await runMigrations(pool);
    const identityRepository = new IdentityRepository(pool);
    identityService = new IdentityService(
      identityRepository,
      new NoopEmailSender(),
      new SignInThrottle(),
      () => now,
      "http://127.0.0.1:3000",
    );
    enrollment = new AgentEnrollmentModule(pool, () => now);

    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ($1, 'owner@example.test', 'owner', 'Owner')`,
      [ownerId],
    );
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'Primary', 'primary', $2)`,
      [workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO device_sessions
         (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $4, $4::timestamptz + interval '30 days')`,
      [ownerSessionId, ownerId, hashToken(ownerSessionToken), now.toISOString()],
    );
  });

  afterEach(async () => {
    await listeningApp?.close();
    listeningApp = undefined;
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
    );
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  it("keeps the replacement secret child-owned through cutover, revocation, and the rollback gate", async () => {
    const runs: CliRun[] = [];
    const childHome = await temporaryHome("atlas-v1");
    const ownerHome = await temporaryHome("atlas-owner");
    const legacyHome = await temporaryHome("atlas-legacy");
    const blockedChildHome = await temporaryHome("atlas-blocked");

    const oldAtlas = await identityService.createAgent(ownerId, {
      username: "atlas",
      displayName: "Atlas",
    });
    const oldCredential = await identityService.createAgentToken(ownerId, oldAtlas.user.id, {
      label: "Atlas legacy pasted token",
      scopes: [...DEFAULT_AGENT_SCOPES],
    });

    const apiOrigin = await startServer(true);
    const port = Number(new URL(apiOrigin).port);
    await saveProfile(
      { env: environment(ownerHome, "owner"), homeDirectory: ownerHome, now: Date.now },
      "owner",
      {
        apiOrigin,
        credential: { kind: "human", sessionToken: ownerSessionToken },
      },
    );
    await saveProfile(
      { env: environment(legacyHome, "atlas-old"), homeDirectory: legacyHome, now: Date.now },
      "atlas-old",
      {
        apiOrigin,
        credential: { kind: "agent", token: oldCredential.token },
      },
    );

    const oldWhoami = await run(runs, legacyHome, "atlas-old", ["auth", "whoami", "--json"]);
    expect(oldWhoami.exitCode).toBe(EXIT_SUCCESS);
    expect(agentCurrentPrincipalSchema.parse(JSON.parse(oldWhoami.stdout))).toMatchObject({
      user: { username: "atlas" },
      scopes: [...DEFAULT_AGENT_SCOPES],
    });

    const childProfile = await run(runs, childHome, "atlas-v1", [
      "profiles",
      "set",
      "atlas-v1",
      "--api-origin",
      apiOrigin,
      "--json",
    ]);
    expect(childProfile.exitCode).toBe(EXIT_SUCCESS);
    const offerRun = await run(runs, childHome, "atlas-v1", [
      "--profile",
      "atlas-v1",
      "agent-enrollments",
      "offer",
      "atlas-agency-v1",
      "--display-name",
      "Atlas",
      "--label",
      "Atlas default agency v1",
      "--json",
    ]);
    expect(offerRun.exitCode).toBe(EXIT_SUCCESS);
    const offer = offerOutputSchema.parse(JSON.parse(offerRun.stdout));
    const offeredStore = await loadProfileStore(path.join(childHome, "config"));
    const candidate = offeredStore.profiles["atlas-v1"]?.credential;
    if (candidate?.kind !== "agent") throw new Error("The child did not retain its candidate");
    expect(offer.request.credentialVerifier).toBe(
      createHash("sha256").update(candidate.token, "utf8").digest("base64url"),
    );
    expect((await lstat(path.join(childHome, "config", "profiles.json"))).mode & 0o777).toBe(0o600);

    const requestRun = await run(runs, ownerHome, "owner", [
      "--profile",
      "owner",
      "agent-enrollments",
      "request",
      offer.request.username,
      "--display-name",
      offer.request.displayName,
      "--label",
      offer.request.label,
      "--credential-verifier",
      offer.request.credentialVerifier,
      "--json",
    ]);
    expect(requestRun.exitCode).toBe(EXIT_SUCCESS);
    const requested = requestOutputSchema.parse(JSON.parse(requestRun.stdout));
    expect(requested.enrollment).toMatchObject({
      status: "pending_approval",
      username: "atlas-agency-v1",
      requestedBy: ownerId,
      requestedByKind: "human",
    });

    const approveRun = await run(runs, ownerHome, "owner", [
      "--profile",
      "owner",
      "agent-enrollments",
      "approve",
      requested.enrollment.id,
      "--json",
    ]);
    expect(approveRun.exitCode).toBe(EXIT_SUCCESS);
    expect(
      agentEnrollmentResponseSchema.parse(JSON.parse(approveRun.stdout)).enrollment,
    ).toMatchObject({
      id: requested.enrollment.id,
      status: "ready_to_redeem",
      reviewedBy: ownerId,
    });

    const redeemRun = await run(runs, childHome, "atlas-v1", [
      "--profile",
      "atlas-v1",
      "agent-enrollments",
      "redeem",
      requested.enrollment.id,
      "--json",
    ]);
    expect(redeemRun.exitCode).toBe(EXIT_SUCCESS);
    const redeemed = redeemOutputSchema.parse(JSON.parse(redeemRun.stdout));
    expect(redeemed).toMatchObject({
      enrollment: { status: "active", username: "atlas-agency-v1" },
      agent: { user: { username: "atlas-agency-v1" }, status: "active" },
      principal: {
        user: { username: "atlas-agency-v1" },
        scopes: [...DEFAULT_AGENCY_AGENT_SCOPES],
      },
      profile: "atlas-v1",
      saved: true,
    });
    const redeemedStore = await loadProfileStore(path.join(childHome, "config"));
    expect(redeemedStore.profiles["atlas-v1"]).toEqual({
      apiOrigin,
      credential: { kind: "agent", token: candidate.token },
    });
    expect(JSON.stringify(await loadProfileStore(path.join(ownerHome, "config")))).not.toContain(
      candidate.token,
    );

    const replacementWhoami = await run(runs, childHome, "atlas-v1", [
      "--profile",
      "atlas-v1",
      "auth",
      "whoami",
      "--json",
    ]);
    expect(replacementWhoami.exitCode).toBe(EXIT_SUCCESS);
    expect(agentCurrentPrincipalSchema.parse(JSON.parse(replacementWhoami.stdout)).scopes).toEqual([
      ...DEFAULT_AGENCY_AGENT_SCOPES,
    ]);

    const enrollmentToken = await pool.query<EnrollmentTokenRow>(
      `SELECT token.token_hash, token.scopes
         FROM agent_enrollments AS enrollment
         JOIN agent_tokens AS token ON token.id = enrollment.activated_agent_token_id
        WHERE enrollment.id = $1`,
      [requested.enrollment.id],
    );
    expect(enrollmentToken.rows[0]?.token_hash.equals(hashToken(candidate.token))).toBe(true);
    expect(enrollmentToken.rows[0]?.scopes).toEqual([...DEFAULT_AGENCY_AGENT_SCOPES]);

    const listRun = await run(runs, ownerHome, "owner", [
      "--profile",
      "owner",
      "agent-tokens",
      "list",
      "atlas",
      "--json",
    ]);
    expect(listRun.exitCode).toBe(EXIT_SUCCESS);
    const listed = tokenListOutputSchema.parse(JSON.parse(listRun.stdout));
    const listedOldToken = listed.tokens.find(
      (token) => token.label === "Atlas legacy pasted token",
    );
    expect(listedOldToken).toMatchObject({
      id: oldCredential.agentToken.id,
      revokedAt: null,
    });
    if (listedOldToken === undefined) throw new Error("The old Atlas token was not listed");

    const revokeRun = await run(runs, ownerHome, "owner", [
      "--profile",
      "owner",
      "agent-tokens",
      "revoke",
      "atlas",
      listedOldToken.id,
      "--json",
    ]);
    expect(revokeRun.exitCode).toBe(EXIT_SUCCESS);
    expect(revokeOutputSchema.parse(JSON.parse(revokeRun.stdout))).toEqual({
      agentId: oldAtlas.user.id,
      revoked: listedOldToken.id,
    });
    const revokedRow = await pool.query<RevokedTokenRow>(
      "SELECT revoked_at FROM agent_tokens WHERE id = $1",
      [listedOldToken.id],
    );
    expect(revokedRow.rows[0]?.revoked_at).toEqual(now);
    const revokedWhoami = await run(runs, legacyHome, "atlas-old", [
      "--profile",
      "atlas-old",
      "auth",
      "whoami",
      "--json",
    ]);
    expect(revokedWhoami.exitCode).toBe(EXIT_AUTH);
    expect(cliErrorOutputSchema.parse(JSON.parse(revokedWhoami.stderr)).error).toMatchObject({
      code: "UNAUTHORIZED",
      httpStatus: 401,
    });

    await listeningApp.close();
    listeningApp = undefined;
    await startServer(false, port);

    const activeDuringRollback = await run(runs, childHome, "atlas-v1", [
      "--profile",
      "atlas-v1",
      "auth",
      "whoami",
      "--json",
    ]);
    expect(activeDuringRollback.exitCode).toBe(EXIT_SUCCESS);
    expect(
      agentCurrentPrincipalSchema.parse(JSON.parse(activeDuringRollback.stdout)).scopes,
    ).toEqual([...DEFAULT_AGENCY_AGENT_SCOPES]);

    const blockedProfile = await run(runs, blockedChildHome, "blocked-atlas", [
      "profiles",
      "set",
      "blocked-atlas",
      "--api-origin",
      apiOrigin,
      "--json",
    ]);
    expect(blockedProfile.exitCode).toBe(EXIT_SUCCESS);
    const blockedOfferRun = await run(runs, blockedChildHome, "blocked-atlas", [
      "--profile",
      "blocked-atlas",
      "agent-enrollments",
      "offer",
      "blocked-atlas",
      "--display-name",
      "Blocked Atlas",
      "--label",
      "Blocked during rollback",
      "--json",
    ]);
    expect(blockedOfferRun.exitCode).toBe(EXIT_SUCCESS);
    const blockedOffer = offerOutputSchema.parse(JSON.parse(blockedOfferRun.stdout));
    const blockedRequest = await run(runs, ownerHome, "owner", [
      "--profile",
      "owner",
      "agent-enrollments",
      "request",
      blockedOffer.request.username,
      "--display-name",
      blockedOffer.request.displayName,
      "--label",
      blockedOffer.request.label,
      "--credential-verifier",
      blockedOffer.request.credentialVerifier,
      "--json",
    ]);
    expect(blockedRequest.exitCode).toBe(EXIT_TRANSIENT);
    expect(cliErrorOutputSchema.parse(JSON.parse(blockedRequest.stderr)).error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      httpStatus: 503,
    });
    expect(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM agent_enrollments WHERE username = $1",
          [blockedOffer.request.username],
        )
      ).rows[0]?.count,
    ).toBe(0);

    const externallyVisibleEvidence = runs
      .flatMap((entry) => [JSON.stringify(entry.argv), entry.stdout, entry.stderr])
      .join("\n");
    expect(externallyVisibleEvidence).not.toContain(candidate.token);
    expect(externallyVisibleEvidence).not.toContain(oldCredential.token);
    expect(externallyVisibleEvidence).not.toMatch(/hype_comms_agent_[A-Za-z0-9_-]+/u);
  });
});
