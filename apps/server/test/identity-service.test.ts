import { randomUUID } from "node:crypto";

import {
  apiErrorEnvelopeSchema,
  currentUserSchema,
  emailSchema,
  magicLinkRequestedSchema,
  magicLinkTokenSchema,
  type Email,
} from "@hmm-chat/contracts";
import { escapeIdentifier, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import type { EmailSender, SendMagicLinkInput } from "../src/modules/identity/email.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { hashToken } from "../src/modules/identity/tokens.js";
import { SignInThrottle } from "../src/throttle.js";

const testDatabaseUrl = process.env.HMM_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const initialNow = Date.parse("2026-07-24T12:00:00.000Z");

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

class FakeEmailSender implements EmailSender {
  readonly sent: SendMagicLinkInput[] = [];

  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
    this.sent.push(input);
  }

  latestTokenFor(email: Email): string {
    const message = this.sent.findLast(({ to }) => to === email);
    if (message === undefined) throw new Error(`No message sent to ${email}`);
    return magicLinkTokenSchema.parse(new URL(message.url).searchParams.get("token"));
  }
}

describeWithPostgres("IdentityService and identity routes", () => {
  const schemaName = `identity_service_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: IdentityRepository;
  let sender: FakeEmailSender;
  let nowMs: number;
  let service: IdentityService;
  let reuseDetections: number;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 8 });
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE device_sessions, magic_link_tokens, invitations, workspace_memberships,
               workspaces, users
      CASCADE
    `);
    repository = new IdentityRepository(pool);
    sender = new FakeEmailSender();
    nowMs = initialNow;
    reuseDetections = 0;
    service = new IdentityService(
      repository,
      sender,
      new SignInThrottle({ maxFailures: 10, windowMs: 15 * 60_000, now: () => nowMs }),
      () => new Date(nowMs),
      "http://127.0.0.1:3000",
      { tokenReuseDetected: () => (reuseDetections += 1) },
    );
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  async function seedOwner(email = "owner@example.com") {
    const normalized = emailSchema.parse(email);
    await service.seedOwner({
      email: normalized,
      workspaceName: "HMM",
      workspaceSlug: "hmm",
    });
    const owner = await repository.findUserByEmail(normalized);
    if (owner === null) throw new Error("Owner was not seeded");
    return owner;
  }

  async function requestToken(email: string, ip = "127.0.0.1"): Promise<string> {
    const normalized = emailSchema.parse(email);
    await service.requestMagicLink(normalized, ip);
    return sender.latestTokenFor(normalized);
  }

  async function signIn(email: string, ip = "127.0.0.1") {
    return service.redeemMagicLink(await requestToken(email, ip), "Test device");
  }

  it("seeds the owner idempotently", async () => {
    await seedOwner();
    await service.seedOwner({
      email: emailSchema.parse("different@example.com"),
      workspaceName: "Changed",
      workspaceSlug: "hmm",
    });

    const result = await pool.query<{ workspace_count: number; owner_count: number }>(`
      SELECT
        (SELECT count(*)::integer FROM workspaces) AS workspace_count,
        (SELECT count(*)::integer
           FROM workspace_memberships
          WHERE role = 'owner' AND status = 'active') AS owner_count
    `);
    expect(result.rows[0]).toEqual({ workspace_count: 1, owner_count: 1 });
    expect(await repository.findUserByEmail(emailSchema.parse("different@example.com"))).toBeNull();
  });

  it("keeps an owner active as owner after an administrative sign-in link is redeemed", async () => {
    const owner = await seedOwner();
    const session = await signIn("owner@example.com");
    const membership = await repository.findActiveMembershipByUserId(owner.id);

    expect(membership).toMatchObject({
      userId: owner.id,
      role: "owner",
      status: "active",
    });
    expect(await service.authenticate(session.token)).toMatchObject({
      email: "owner@example.com",
      role: "owner",
    });
  });

  it("does not reduce an active owner's role when their member invitation is redeemed", async () => {
    const owner = await seedOwner();
    const invitation = await service.createInvitation(
      owner.id,
      emailSchema.parse("owner@example.com"),
      "member",
    );
    const session = await signIn("owner@example.com");
    const membership = await repository.findActiveMembershipByUserId(owner.id);

    expect(await repository.findInvitationById(invitation.id)).toMatchObject({
      status: "accepted",
    });
    expect(membership).toMatchObject({
      userId: owner.id,
      role: "owner",
      status: "active",
    });
    expect(await service.authenticate(session.token)).toMatchObject({
      email: "owner@example.com",
      role: "owner",
    });
  });

  it("activates a genuinely new invitee as a member", async () => {
    const owner = await seedOwner();
    await service.createInvitation(owner.id, emailSchema.parse("new@example.com"), "member");
    const session = await signIn("new@example.com");
    const member = await repository.findUserByEmail(emailSchema.parse("new@example.com"));
    if (member === null) throw new Error("Invited member was not created");

    expect(await repository.findActiveMembershipByUserId(member.id)).toMatchObject({
      role: "member",
      status: "active",
    });
    expect(await service.authenticate(session.token)).toMatchObject({
      email: "new@example.com",
      role: "member",
    });
  });

  it("reactivates a revoked member when they are invited again", async () => {
    const owner = await seedOwner();
    const email = emailSchema.parse("returning@example.com");
    await service.createInvitation(owner.id, email, "member");
    await signIn(email, "127.0.0.1");
    const member = await repository.findUserByEmail(email);
    const ownerMembership = await repository.findActiveMembershipByUserId(owner.id);
    if (member === null || ownerMembership === null) {
      throw new Error("Seeded identities are missing");
    }
    await repository.upsertMembership({
      workspaceId: ownerMembership.workspaceId,
      userId: member.id,
      role: "member",
      status: "revoked",
    });

    await service.createInvitation(owner.id, email, "member");
    const session = await signIn(email, "127.0.0.2");

    expect(await repository.findMembership(ownerMembership.workspaceId, member.id)).toMatchObject({
      role: "member",
      status: "active",
    });
    expect(await service.authenticate(session.token)).toMatchObject({
      email,
      role: "member",
    });
  });

  it("derives unique usernames with deterministic numeric collision suffixes", async () => {
    const owner = await seedOwner("member+tag@example.com");
    await service.createInvitation(owner.id, emailSchema.parse("member-tag@example.com"), "member");
    await signIn("member-tag@example.com");

    expect(
      await repository.findUserByEmail(emailSchema.parse("member+tag@example.com")),
    ).toMatchObject({ username: "member-tag" });
    expect(
      await repository.findUserByEmail(emailSchema.parse("member-tag@example.com")),
    ).toMatchObject({ username: "member-tag-2" });
  });

  it("runs the full owner invite, redemption, and authenticated /me path", async () => {
    const owner = await seedOwner();
    const ownerSession = await signIn("owner@example.com");
    const app = await buildApp({
      cookieSecure: false,
      identity: { service },
    });

    const invitationResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/invitations",
      headers: { cookie: `hmm_session=${ownerSession.token}` },
      payload: { email: "invitee@example.com", role: "member" },
    });
    await service.requestMagicLink(emailSchema.parse("invitee@example.com"), "127.0.0.2");
    const redemption = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      headers: { "user-agent": "Vitest browser" },
      payload: { token: sender.latestTokenFor(emailSchema.parse("invitee@example.com")) },
    });
    const cookie = redemption.cookies.find(({ name }) => name === "hmm_session");
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: `hmm_session=${cookie?.value ?? ""}` },
    });
    await app.close();

    expect(invitationResponse.statusCode).toBe(201);
    expect(invitationResponse.json()).toMatchObject({
      email: "invitee@example.com",
      invitedBy: owner.id,
      status: "pending",
    });
    expect(redemption.statusCode).toBe(200);
    expect(redemption.json().user).not.toHaveProperty("kind");
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    expect(cookie?.secure).toBeUndefined();
    expect(me.json().user).not.toHaveProperty("kind");
    expect(currentUserSchema.parse(me.json())).toMatchObject({
      email: "invitee@example.com",
      role: "member",
    });
  });

  it("serves a non-consuming magic-link landing page with leak-resistant headers", async () => {
    await seedOwner();
    const token = await requestToken("owner@example.com");
    const app = await buildApp({ cookieSecure: false, identity: { service } });

    const landing = await app.inject({
      method: "GET",
      url: `/auth/magic-link?token=${token}`,
    });
    const redemption = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      payload: { token },
    });
    await app.close();

    expect(landing.statusCode).toBe(200);
    expect(landing.body).toContain(`hmm-chat://auth/callback?token=${token}`);
    expect(landing.headers["referrer-policy"]).toBe("no-referrer");
    expect(landing.headers["cache-control"]).toContain("no-store");
    expect(landing.headers.pragma).toBe("no-cache");
    expect(landing.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(redemption.statusCode).toBe(200);
  });

  it("renders the same invalid landing page for missing and malformed tokens", async () => {
    const app = await buildApp({ identity: { service } });

    const [missing, malformed] = await Promise.all([
      app.inject({ method: "GET", url: "/auth/magic-link" }),
      app.inject({ method: "GET", url: "/auth/magic-link?token=not-a-token" }),
    ]);
    await app.close();

    expect(missing.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(missing.body).toBe(malformed.body);
    expect(malformed.body).toContain("This link is not valid.");
    expect(malformed.body).not.toContain("not-a-token");
  });

  it("burns an expired magic link on its first attempted redemption", async () => {
    await seedOwner();
    const token = await requestToken("owner@example.com");
    nowMs += 16 * 60_000;

    await expect(service.redeemMagicLink(token, null)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    await expect(service.redeemMagicLink(token, null)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("rejects expired sessions from authentication and refresh", async () => {
    await seedOwner();
    const session = await signIn("owner@example.com");
    nowMs += 31 * 24 * 60 * 60_000;

    expect(await service.authenticate(session.token)).toBeNull();
    await expect(service.refreshSession(session.token)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("rotates a session and immediately invalidates its previous token", async () => {
    await seedOwner();
    const session = await signIn("owner@example.com");
    const refreshed = await service.refreshSession(session.token);

    expect(refreshed.token).not.toBe(session.token);
    expect(await service.authenticate(session.token)).toBeNull();
    expect(await service.authenticate(refreshed.token)).toMatchObject({
      email: "owner@example.com",
      role: "owner",
    });
  });

  it("revokes a rotated lineage when its historical refresh token is replayed", async () => {
    await seedOwner();
    const original = await signIn("owner@example.com");
    const record = await repository.findDeviceSessionByTokenHash(hashToken(original.token));
    if (record === null) throw new Error("Session was not created");
    const successor = await service.refreshSession(original.token);
    const warnings: Array<{ readonly details: Record<string, unknown>; readonly message: string }> =
      [];

    await expect(
      service.refreshSession(original.token, {
        error() {},
        warn(details, message) {
          warnings.push({ details, message });
        },
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    await expect(service.refreshSession(successor.token)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });

    expect(reuseDetections).toBe(1);
    expect(warnings).toEqual([
      {
        details: { deviceSessionId: record.id },
        message: "Refresh-token reuse detected; device-session lineage revoked",
      },
    ]);
  });

  it("keeps sequential rotation working across several token generations", async () => {
    await seedOwner();
    const original = await signIn("owner@example.com");
    const historicalHashes = [hashToken(original.token)];
    let current = original;

    for (let generation = 0; generation < 3; generation += 1) {
      current = await service.refreshSession(current.token);
      if (generation < 2) historicalHashes.push(hashToken(current.token));
    }
    const history = await pool.query<{ token_hash: Buffer }>(
      "SELECT token_hash FROM device_session_token_history",
    );

    expect(await service.authenticate(current.token)).toMatchObject({
      email: "owner@example.com",
    });
    expect(
      history.rows.map(({ token_hash: tokenHash }) => tokenHash.toString("hex")).sort(),
    ).toEqual(historicalHashes.map((tokenHash) => tokenHash.toString("hex")).sort());
    expect(reuseDetections).toBe(0);
  });

  it("does not flag two overlapping legitimate rotations as token reuse", async () => {
    await seedOwner();
    const original = await signIn("owner@example.com");

    const attempts = await Promise.allSettled([
      service.refreshSession(original.token),
      service.refreshSession(original.token),
    ]);
    const winners = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<typeof original>> =>
        attempt.status === "fulfilled",
    );

    expect(winners).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ statusCode: 401, code: "UNAUTHORIZED" }),
      }),
    ]);
    await expect(service.refreshSession(winners[0]?.value.token ?? "")).resolves.toBeDefined();
    const history = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM device_session_token_history",
    );
    expect(history.rows[0]?.count).toBe(2);
    expect(reuseDetections).toBe(0);
  });

  it("does not revoke a lineage for reuse after the historical credential expires", async () => {
    await seedOwner();
    const original = await signIn("owner@example.com");
    nowMs += 29 * 24 * 60 * 60_000;
    const successor = await service.refreshSession(original.token);
    nowMs += 2 * 24 * 60 * 60_000;

    await expect(service.refreshSession(original.token)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    await expect(service.deleteExpiredDeviceSessionTokenHistory()).resolves.toBe(1);
    await expect(service.refreshSession(successor.token)).resolves.toBeDefined();
    expect(reuseDetections).toBe(0);
  });

  it("scopes historical-token reuse revocation to one device lineage", async () => {
    await seedOwner();
    const compromised = await signIn("owner@example.com", "127.0.0.1");
    const unrelated = await signIn("owner@example.com", "127.0.0.2");
    const compromisedSuccessor = await service.refreshSession(compromised.token);

    await expect(service.refreshSession(compromised.token)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    await expect(service.refreshSession(compromisedSuccessor.token)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    await expect(service.refreshSession(unrelated.token)).resolves.toBeDefined();
    expect(reuseDetections).toBe(1);
  });

  it("slides the session expiry on refresh so an active device is never signed out", async () => {
    await seedOwner();
    const session = await signIn("owner@example.com");
    nowMs += 29 * 24 * 60 * 60_000;
    const renewed = await service.refreshSession(session.token);
    const renewedAt = nowMs;
    // Day 31 of this device's life: past the original expiry, two days into the renewed window.
    nowMs += 2 * 24 * 60 * 60_000;

    expect(Date.parse(session.expiresAt)).toBe(initialNow + 30 * 24 * 60 * 60_000);
    expect(Date.parse(renewed.expiresAt)).toBe(renewedAt + 30 * 24 * 60 * 60_000);
    expect(await service.authenticate(renewed.token)).toMatchObject({
      email: "owner@example.com",
      role: "owner",
    });
    // A second renewal has to slide the window again, or the device only ever buys one extension.
    await expect(service.refreshSession(renewed.token)).resolves.toMatchObject({
      expiresAt: new Date(nowMs + 30 * 24 * 60 * 60_000).toISOString(),
    });
  });

  it("re-issues the session cookie against the renewed expiry on refresh", async () => {
    await seedOwner();
    const session = await signIn("owner@example.com");
    const app = await buildApp({ cookieSecure: false, identity: { service } });
    nowMs += 29 * 24 * 60 * 60_000;

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/session/refresh",
      headers: { cookie: `hmm_session=${session.token}` },
    });
    await app.close();
    const cookie = response.cookies.find(({ name }) => name === "hmm_session");

    expect(response.statusCode).toBe(204);
    expect(cookie?.value).not.toBe(session.token);
    expect(cookie?.expires?.getTime() ?? 0).toBe(nowMs + 30 * 24 * 60 * 60_000);
  });

  it("refuses to renew a revoked or already expired session back into a live one", async () => {
    await seedOwner();
    const revoked = await signIn("owner@example.com", "127.0.0.1");
    const stale = await signIn("owner@example.com", "127.0.0.2");
    const revokedRecord = await repository.findDeviceSessionByTokenHash(hashToken(revoked.token));
    const staleRecord = await repository.findDeviceSessionByTokenHash(hashToken(stale.token));
    if (revokedRecord === null || staleRecord === null) throw new Error("Session was not created");
    await repository.revokeDeviceSession(revokedRecord.id, new Date(nowMs).toISOString());

    await expect(service.refreshSession(revoked.token)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    const revokedRotation = await repository.rotateDeviceSession(
      hashToken(revoked.token),
      Buffer.alloc(32, 7),
      new Date(nowMs).toISOString(),
      new Date(nowMs + 30 * 24 * 60 * 60_000).toISOString(),
    );

    nowMs += 31 * 24 * 60 * 60_000;
    await expect(service.refreshSession(stale.token)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    const staleRotation = await repository.rotateDeviceSession(
      hashToken(stale.token),
      Buffer.alloc(32, 8),
      new Date(nowMs).toISOString(),
      new Date(nowMs + 30 * 24 * 60 * 60_000).toISOString(),
    );
    const stored = await pool.query<{ expires_at: Date }>(
      "SELECT expires_at FROM device_sessions ORDER BY id",
    );

    expect(revokedRotation.status).toBe("unavailable");
    expect(staleRotation.status).toBe("unavailable");
    // Neither dead session may have had its window extended by the attempted renewal.
    expect(stored.rows.map((row) => row.expires_at.toISOString())).toEqual([
      revokedRecord.expiresAt,
      staleRecord.expiresAt,
    ]);
    expect(await service.authenticate(stale.token)).toBeNull();
  });

  it("routes device listing, refresh, targeted revocation, and sign-out", async () => {
    await seedOwner();
    const first = await signIn("owner@example.com", "127.0.0.1");
    const second = await signIn("owner@example.com", "127.0.0.2");
    const app = await buildApp({ cookieSecure: false, identity: { service } });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/auth/devices",
      headers: { cookie: `hmm_session=${first.token}` },
    });
    const refreshed = await app.inject({
      method: "POST",
      url: "/v1/auth/session/refresh",
      headers: { cookie: `hmm_session=${first.token}` },
    });
    const refreshedCookie = refreshed.cookies.find(({ name }) => name === "hmm_session");
    const oldToken = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: `hmm_session=${first.token}` },
    });
    const secondRecord = await repository.findDeviceSessionByTokenHash(hashToken(second.token));
    if (secondRecord === null) throw new Error("Second session was not created");
    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/auth/devices/${secondRecord.id}`,
      headers: { cookie: `hmm_session=${refreshedCookie?.value ?? ""}` },
    });
    const signedOut = await app.inject({
      method: "DELETE",
      url: "/v1/auth/session",
      headers: { cookie: `hmm_session=${refreshedCookie?.value ?? ""}` },
    });
    await app.close();

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(2);
    expect(refreshed.statusCode).toBe(204);
    expect(refreshedCookie?.value).not.toBe(first.token);
    expect(oldToken.statusCode).toBe(401);
    expect(revoked.statusCode).toBe(204);
    expect(await service.authenticate(second.token)).toBeNull();
    expect(signedOut.statusCode).toBe(204);
    expect(signedOut.cookies.find(({ name }) => name === "hmm_session")).toMatchObject({
      value: "",
      maxAge: 0,
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    expect(await service.authenticate(refreshedCookie?.value ?? "")).toBeNull();
  });

  it("revokes exactly one owned device and never another user's device", async () => {
    const owner = await seedOwner();
    const first = await signIn("owner@example.com", "127.0.0.1");
    const second = await signIn("owner@example.com", "127.0.0.2");
    const invitation = await service.createInvitation(
      owner.id,
      emailSchema.parse("invitee@example.com"),
      "member",
    );
    const inviteeSession = await signIn("invitee@example.com", "127.0.0.3");
    const invitee = await repository.findUserByEmail(emailSchema.parse("invitee@example.com"));
    if (invitee === null) throw new Error("Invitee was not created");
    const firstRecord = await repository.findDeviceSessionByTokenHash(hashToken(first.token));
    const inviteeRecord = await repository.findDeviceSessionByTokenHash(
      hashToken(inviteeSession.token),
    );
    if (firstRecord === null || inviteeRecord === null) throw new Error("Session was not created");

    expect(invitation.status).toBe("pending");
    expect(await service.revokeDevice(owner.id, inviteeRecord.id)).toBe(false);
    expect(await service.revokeDevice(owner.id, firstRecord.id)).toBe(true);
    expect(await service.authenticate(first.token)).toBeNull();
    expect(await service.authenticate(second.token)).not.toBeNull();
    expect(await service.authenticate(inviteeSession.token)).not.toBeNull();
    expect(
      (await service.listDevices(invitee.id)).filter(({ revokedAt }) => revokedAt === null),
    ).toHaveLength(1);
  });

  it("forbids a non-owner from creating an invitation", async () => {
    const owner = await seedOwner();
    await service.createInvitation(owner.id, emailSchema.parse("member@example.com"), "member");
    const memberSession = await signIn("member@example.com");
    const member = await repository.findUserByEmail(emailSchema.parse("member@example.com"));
    if (member === null) throw new Error("Member was not created");
    const app = await buildApp({ identity: { service } });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/invitations",
      headers: { cookie: `hmm_session=${memberSession.token}` },
      payload: { email: "other@example.com", role: "member" },
    });
    await app.close();

    await expect(
      service.createInvitation(member.id, emailSchema.parse("other@example.com"), "member"),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    expect(response.statusCode).toBe(403);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe("FORBIDDEN");
  });

  it("blocks activation of the 26th active member", async () => {
    const owner = await seedOwner();
    const tokens: string[] = [];
    for (let index = 1; index <= 25; index += 1) {
      const email = emailSchema.parse(`member-${index}@example.com`);
      await service.createInvitation(owner.id, email, "member");
      await service.requestMagicLink(email, `127.0.1.${index}`);
      tokens.push(sender.latestTokenFor(email));
    }
    for (const token of tokens.slice(0, 23)) {
      await service.redeemMagicLink(token, null);
    }

    const competingActivations = await Promise.allSettled([
      service.redeemMagicLink(tokens[23] ?? "", null),
      service.redeemMagicLink(tokens[24] ?? "", null),
    ]);
    expect(competingActivations.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(competingActivations.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ statusCode: 409, code: "CONFLICT" }),
      }),
    ]);
    const membership = await repository.findActiveMembershipByUserId(owner.id);
    if (membership === null) throw new Error("Owner membership is missing");
    expect(await repository.countActiveMembers(membership.workspaceId)).toBe(25);
  });

  it("returns the same accepted response without emailing unknown or throttled callers", async () => {
    const owner = await seedOwner();
    await service.createInvitation(owner.id, emailSchema.parse("invited-a@example.com"), "member");
    await service.createInvitation(owner.id, emailSchema.parse("invited-b@example.com"), "member");
    service = new IdentityService(
      repository,
      sender,
      new SignInThrottle({ maxFailures: 1, windowMs: 60_000, now: () => nowMs }),
      () => new Date(nowMs),
      "http://127.0.0.1:3000",
    );

    const app = await buildApp({ identity: { service } });
    const invitedResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/magic-link",
      payload: { email: "invited-a@example.com" },
    });
    await app.close();
    const invited = magicLinkRequestedSchema.parse(invitedResponse.json());
    const unknown = await service.requestMagicLink(
      emailSchema.parse("unknown@example.com"),
      "127.0.0.2",
    );
    const emailLimited = await service.requestMagicLink(
      emailSchema.parse("invited-a@example.com"),
      "127.0.0.3",
    );
    const ipLimited = await service.requestMagicLink(
      emailSchema.parse("invited-b@example.com"),
      "127.0.0.1",
    );

    expect([invited, unknown, emailLimited, ipLimited]).toEqual([
      magicLinkRequestedSchema.parse({ status: "accepted" }),
      magicLinkRequestedSchema.parse({ status: "accepted" }),
      magicLinkRequestedSchema.parse({ status: "accepted" }),
      magicLinkRequestedSchema.parse({ status: "accepted" }),
    ]);
    expect(invitedResponse.statusCode).toBe(202);
    expect(sender.sent.map(({ to }) => to)).toEqual(["invited-a@example.com"]);
  });

  it("rejects revoked and expired invitations and accepts an invitation only once", async () => {
    const owner = await seedOwner();
    const revoked = await service.createInvitation(
      owner.id,
      emailSchema.parse("revoked@example.com"),
      "member",
    );
    const revokedToken = await requestToken("revoked@example.com", "127.0.0.1");
    await repository.markInvitationRevoked(revoked.id);
    await expect(service.redeemMagicLink(revokedToken, null)).rejects.toMatchObject({
      statusCode: 401,
    });

    const expired = await service.createInvitation(
      owner.id,
      emailSchema.parse("expired@example.com"),
      "member",
    );
    const expiredToken = await requestToken("expired@example.com", "127.0.0.2");
    await pool.query("UPDATE invitations SET expires_at = $2 WHERE id = $1", [
      expired.id,
      new Date(nowMs - 1),
    ]);
    await expect(service.redeemMagicLink(expiredToken, null)).rejects.toMatchObject({
      statusCode: 401,
    });

    await service.createInvitation(owner.id, emailSchema.parse("single@example.com"), "member");
    const first = await requestToken("single@example.com", "127.0.0.3");
    const second = await requestToken("single@example.com", "127.0.0.4");
    await service.redeemMagicLink(first, null);
    await expect(service.redeemMagicLink(second, null)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
