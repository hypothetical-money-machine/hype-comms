import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import {
  AuthKitAdmissionDeniedError,
  AuthKitCredentialRejectedError,
  AuthKitRepository,
  deleteExpiredAuthKitState,
  deriveAuthKitPkceCodeChallenge,
  prepareAuthKitRollback,
} from "../src/modules/identity/authkit-repository.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { hashToken } from "../src/modules/identity/tokens.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const encryptionKey = Buffer.alloc(32, 19);
const ownerId = "10000000-0000-4000-8000-000000000101";
const workspaceId = "10000000-0000-4000-8000-000000000102";
const desktopVerifier = "desktop-verifier-value-that-is-long-enough-1234";
const desktopChallenge = deriveAuthKitPkceCodeChallenge(desktopVerifier);

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

describeWithPostgres("AuthKitRepository", () => {
  const schemaName = `authkit_repository_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: AuthKitRepository;
  let identityRepository: IdentityRepository;
  let now: Date;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;

    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 8 });
    await runMigrations(pool);
    repository = new AuthKitRepository(pool, encryptionKey);
    identityRepository = new IdentityRepository(pool);
  });

  beforeEach(async () => {
    now = new Date();
    await pool.query("TRUNCATE authkit_transactions, workos_events, users CASCADE");
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;

    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  async function seedOwner(email = "owner@example.com", username = "owner"): Promise<void> {
    await identityRepository.insertUser({
      id: ownerId,
      email,
      username,
      displayName: "Workspace Owner",
      avatarUrl: null,
    });
    await identityRepository.insertWorkspace({
      id: workspaceId,
      name: "Hype Comms",
      slug: "hype-comms",
      createdBy: ownerId,
    });
    await identityRepository.upsertMembership({
      workspaceId,
      userId: ownerId,
      role: "owner",
      status: "active",
    });
  }

  async function invite(email: string, expiresAt = new Date(now.getTime() + 60 * 60 * 1_000)) {
    return identityRepository.insertInvitation({
      id: randomUUID(),
      workspaceId,
      email,
      role: "member",
      invitedBy: ownerId,
      expiresAt: expiresAt.toISOString(),
    });
  }

  async function admitAndExchange(input: {
    providerSubject: string;
    email?: string;
    workosSessionId: string;
    at?: Date;
  }) {
    const at = input.at ?? now;
    const handoff = await repository.admitIdentity({
      providerSubject: input.providerSubject,
      verifiedEmail: input.email ?? "owner@example.com",
      workosSessionId: input.workosSessionId,
      desktopCodeChallenge: desktopChallenge,
      now: at,
    });
    return repository.exchangeHandoff({
      handoffCode: handoff.handoffCode,
      codeVerifier: desktopVerifier,
      label: "AuthKit test device",
      now: at,
    });
  }

  it("atomically consumes and scrubs an encrypted provider transaction", async () => {
    const providerState = "provider-state-value-that-is-long-enough-123";
    const providerCodeVerifier = "provider-verifier-value-that-is-long-enough-123";
    const desktopState = "D".repeat(43);
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1_000);
    await repository.createTransaction({
      providerState,
      providerCodeVerifier,
      desktopCodeChallenge: desktopChallenge,
      desktopState,
      desktopAuthVariant: "development",
      expiresAt,
    });

    const stored = await pool.query<{
      provider_state_hash: Buffer;
      verifier_ciphertext: Buffer;
    }>("SELECT provider_state_hash, verifier_ciphertext FROM authkit_transactions");
    expect(stored.rows[0]?.provider_state_hash.byteLength).toBe(32);
    expect(stored.rows[0]?.provider_state_hash.toString("utf8")).not.toContain(providerState);
    expect(stored.rows[0]?.verifier_ciphertext.toString("utf8")).not.toContain(
      providerCodeVerifier,
    );

    const consumedAt = new Date(now.getTime() + 1_000);
    const outcomes = await Promise.all([
      repository.consumeTransaction(providerState, consumedAt),
      repository.consumeTransaction(providerState, consumedAt),
    ]);
    expect(outcomes.filter((value) => value !== null)).toEqual([
      {
        providerState,
        providerCodeVerifier,
        desktopCodeChallenge: desktopChallenge,
        desktopState,
        desktopAuthVariant: "development",
        expiresAt,
      },
    ]);
    expect(outcomes.filter((value) => value === null)).toHaveLength(1);

    const scrubbed = await pool.query<{
      consumed_at: Date | null;
      verifier_nonce: Buffer | null;
      verifier_ciphertext: Buffer | null;
      verifier_authentication_tag: Buffer | null;
    }>(
      `SELECT consumed_at, verifier_nonce, verifier_ciphertext, verifier_authentication_tag
         FROM authkit_transactions`,
    );
    expect(scrubbed.rows[0]).toMatchObject({
      consumed_at: consumedAt,
      verifier_nonce: null,
      verifier_ciphertext: null,
      verifier_authentication_tag: null,
    });
  });

  it("does not return or burn an expired provider transaction", async () => {
    const providerState = "provider-state-value-that-is-long-enough-456";
    const expiresAt = new Date(now.getTime() + 60_000);
    await repository.createTransaction({
      providerState,
      providerCodeVerifier: "provider-verifier-value-that-is-long-enough-456",
      desktopCodeChallenge: desktopChallenge,
      desktopState: "E".repeat(43),
      desktopAuthVariant: "production",
      expiresAt,
    });

    expect(
      await repository.consumeTransaction(providerState, new Date(expiresAt.getTime() + 1)),
    ).toBeNull();
    const row = await pool.query<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM authkit_transactions",
    );
    expect(row.rows[0]?.consumed_at).toBeNull();
  });

  it("deletes expired provider state and webhook dedupe rows after 30 days", async () => {
    await repository.createTransaction({
      providerState: "provider-state-value-that-is-long-enough-cleanup",
      providerCodeVerifier: "provider-verifier-value-that-is-long-enough-cleanup",
      desktopCodeChallenge: desktopChallenge,
      desktopState: "F".repeat(43),
      desktopAuthVariant: "production",
      expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
    });
    await seedOwner();
    await repository.admitIdentity({
      providerSubject: "user_cleanup1",
      verifiedEmail: "owner@example.com",
      workosSessionId: "session_cleanup1",
      desktopCodeChallenge: desktopChallenge,
      now,
    });
    const cleanupAt = new Date(now.getTime() + 11 * 60 * 1_000);
    const staleToken = "z".repeat(43);
    const staleDeviceSessionId = randomUUID();
    await identityRepository.insertDeviceSession({
      id: staleDeviceSessionId,
      userId: ownerId,
      tokenHash: hashToken(staleToken),
      label: "Expired AuthKit session",
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(cleanupAt.getTime() - 1).toISOString(),
    });
    await pool.query(
      "UPDATE device_sessions SET workos_session_id = 'session_cleanupexpired1' WHERE id = $1",
      [staleDeviceSessionId],
    );
    const eventCutoff = new Date(cleanupAt.getTime() - 30 * 24 * 60 * 60 * 1_000);
    await pool.query(
      `INSERT INTO workos_events (
         event_id, event_type, workos_session_id, occurred_at, processed_at
       )
       VALUES
         ('event_cleanupold1', 'session.revoked', 'session_cleanupold1', $1, $1),
         ('event_cleanuprecent1', 'session.revoked', 'session_cleanuprecent1', $2, $2)`,
      [eventCutoff, new Date(eventCutoff.getTime() + 1)],
    );

    await expect(repository.deleteExpiredState(cleanupAt)).resolves.toEqual({
      transactions: 1,
      handoffs: 1,
      events: 1,
      sessions: 1,
    });
    const remaining = await pool.query<{
      transactions: number;
      handoffs: number;
      events: number;
      session_links: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM authkit_transactions) AS transactions,
        (SELECT count(*)::integer FROM authkit_handoffs) AS handoffs,
        (SELECT count(*)::integer FROM workos_events) AS events,
        (SELECT count(*)::integer FROM device_sessions
          WHERE workos_session_id IS NOT NULL) AS session_links
    `);
    expect(remaining.rows[0]).toEqual({
      transactions: 0,
      handoffs: 0,
      events: 1,
      session_links: 0,
    });
    await expect(
      identityRepository.findDeviceSessionByTokenHash(hashToken(staleToken)),
    ).resolves.toBeNull();
    await expect(
      pool.query<{ revoked_at: Date | null }>(
        "SELECT revoked_at FROM device_sessions WHERE id = $1",
        [staleDeviceSessionId],
      ),
    ).resolves.toMatchObject({ rows: [{ revoked_at: cleanupAt }] });
    expect(
      (
        await pool.query<{ event_id: string }>(
          "SELECT event_id FROM workos_events ORDER BY event_id",
        )
      ).rows,
    ).toEqual([{ event_id: "event_cleanuprecent1" }]);
  });

  it("cannot renew an expired AuthKit session behind retention cleanup", async () => {
    await seedOwner();
    const sessionId = randomUUID();
    const previousTokenHash = hashToken("r".repeat(43));
    const nextTokenHash = hashToken("n".repeat(43));
    const cleanupAt = new Date(now.getTime() + 60_000);
    await identityRepository.insertDeviceSession({
      id: sessionId,
      userId: ownerId,
      tokenHash: previousTokenHash,
      label: "Expiring AuthKit session",
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: cleanupAt.toISOString(),
    });
    await pool.query(
      "UPDATE device_sessions SET workos_session_id = 'session_cleanuprefresh1' WHERE id = $1",
      [sessionId],
    );

    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query("BEGIN");
      await deleteExpiredAuthKitState(cleanupClient as unknown as Pool, cleanupAt);

      const refresh = identityRepository.refreshDeviceSession({
        previousTokenHash,
        nextTokenHash,
        refreshedAt: new Date(cleanupAt.getTime() - 1).toISOString(),
        expiresAt: new Date(cleanupAt.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      });
      let observedWaitingRefresh = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND query LIKE '%rotation_attempt AS MATERIALIZED%'
                AND wait_event_type = 'Lock'
           ) AS waiting`,
        );
        if (activity.rows[0]?.waiting === true) {
          observedWaitingRefresh = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedWaitingRefresh).toBe(true);
      await cleanupClient.query("COMMIT");

      await expect(refresh).resolves.toEqual({ status: "unavailable" });
    } finally {
      await cleanupClient.query("ROLLBACK").catch(() => undefined);
      cleanupClient.release();
    }

    await expect(
      identityRepository.findDeviceSessionByTokenHash(previousTokenHash),
    ).resolves.toBeNull();
    await expect(
      identityRepository.findDeviceSessionByTokenHash(nextTokenHash),
    ).resolves.toBeNull();
    await expect(
      pool.query<{ revoked_at: Date | null; workos_session_id: string | null }>(
        "SELECT revoked_at, workos_session_id FROM device_sessions WHERE id = $1",
        [sessionId],
      ),
    ).resolves.toMatchObject({
      rows: [{ revoked_at: cleanupAt, workos_session_id: null }],
    });
  });

  it("binds an active human and exchanges a PKCE handoff only once", async () => {
    await seedOwner();
    const handoff = await repository.admitIdentity({
      providerSubject: "user_owner1",
      verifiedEmail: "OWNER@example.com",
      workosSessionId: "session_owner1",
      desktopCodeChallenge: desktopChallenge,
      now,
    });
    expect(handoff.expiresAt).toEqual(new Date(now.getTime() + 5 * 60 * 1_000));

    await expect(
      repository.exchangeHandoff({
        handoffCode: handoff.handoffCode,
        codeVerifier: "B".repeat(43),
        label: "Wrong PKCE",
        now,
      }),
    ).rejects.toBeInstanceOf(AuthKitCredentialRejectedError);
    expect(
      (await pool.query<{ consumed_at: Date | null }>("SELECT consumed_at FROM authkit_handoffs"))
        .rows[0]?.consumed_at,
    ).toBeNull();

    const exchanged = await repository.exchangeHandoff({
      handoffCode: handoff.handoffCode,
      codeVerifier: desktopVerifier,
      label: "Morgan's laptop",
      now,
    });
    expect(exchanged).toMatchObject({
      userId: ownerId,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    expect(
      await identityRepository.findDeviceSessionByTokenHash(hashToken(exchanged.token)),
    ).toMatchObject({
      userId: ownerId,
      label: "Morgan's laptop",
    });
    const persisted = await pool.query<{ workos_session_id: string }>(
      "SELECT workos_session_id FROM device_sessions",
    );
    expect(persisted.rows[0]?.workos_session_id).toBe("session_owner1");

    await expect(
      repository.exchangeHandoff({
        handoffCode: handoff.handoffCode,
        codeVerifier: desktopVerifier,
        label: null,
        now,
      }),
    ).rejects.toBeInstanceOf(AuthKitCredentialRejectedError);
  });

  it("activates an unexpired invitation with current username collision rules", async () => {
    await seedOwner("member+tag@example.com", "member-tag");
    const invitation = await invite("member-tag@example.com");

    await repository.admitIdentity({
      providerSubject: "user_invitee1",
      verifiedEmail: "MEMBER-TAG@example.com",
      workosSessionId: "session_invitee1",
      desktopCodeChallenge: desktopChallenge,
      now,
    });

    const user = await identityRepository.findUserByEmail("member-tag@example.com");
    expect(user).toMatchObject({ username: "member-tag-2", displayName: "member-tag" });
    expect(await identityRepository.findInvitationById(invitation.id)).toMatchObject({
      status: "accepted",
      acceptedAt: now.toISOString(),
    });
    expect(
      user === null ? null : await identityRepository.findActiveMembershipByUserId(user.id),
    ).toMatchObject({ workspaceId, role: "member", status: "active" });
    const mapping = await pool.query<{
      provider_subject: string;
      last_verified_email: string;
    }>("SELECT provider_subject, last_verified_email FROM external_identities");
    expect(mapping.rows[0]).toEqual({
      provider_subject: "user_invitee1",
      last_verified_email: "member-tag@example.com",
    });
  });

  it("denies unknown, expired, and over-capacity invitations without partial activation", async () => {
    await seedOwner();
    await expect(
      repository.admitIdentity({
        providerSubject: "user_unknown1",
        verifiedEmail: "unknown@example.com",
        workosSessionId: "session_unknown1",
        desktopCodeChallenge: desktopChallenge,
        now,
      }),
    ).rejects.toBeInstanceOf(AuthKitAdmissionDeniedError);

    await invite("expired@example.com", new Date(now.getTime() - 1));
    await expect(
      repository.admitIdentity({
        providerSubject: "user_expired1",
        verifiedEmail: "expired@example.com",
        workosSessionId: "session_expired1",
        desktopCodeChallenge: desktopChallenge,
        now,
      }),
    ).rejects.toBeInstanceOf(AuthKitAdmissionDeniedError);

    for (let index = 1; index < 25; index += 1) {
      const userId = randomUUID();
      await identityRepository.insertUser({
        id: userId,
        email: `member-${String(index)}@example.com`,
        username: `member-${String(index)}`,
        displayName: `Member ${String(index)}`,
        avatarUrl: null,
      });
      await identityRepository.upsertMembership({
        workspaceId,
        userId,
        role: "member",
        status: "active",
      });
    }
    const capacityInvitation = await invite("overflow@example.com");
    await expect(
      repository.admitIdentity({
        providerSubject: "user_overflow1",
        verifiedEmail: "overflow@example.com",
        workosSessionId: "session_overflow1",
        desktopCodeChallenge: desktopChallenge,
        now,
      }),
    ).rejects.toBeInstanceOf(AuthKitAdmissionDeniedError);

    expect(await identityRepository.findUserByEmail("overflow@example.com")).toBeNull();
    expect(await identityRepository.findInvitationById(capacityInvitation.id)).toMatchObject({
      status: "pending",
    });
    const counts = await pool.query<{ identities: number; handoffs: number }>(`
      SELECT
        (SELECT count(*)::integer FROM external_identities) AS identities,
        (SELECT count(*)::integer FROM authkit_handoffs) AS handoffs
    `);
    expect(counts.rows[0]).toEqual({ identities: 0, handoffs: 0 });
  });

  it("enforces a stable one-to-one WorkOS subject mapping under concurrency", async () => {
    await seedOwner();

    const outcomes = await Promise.allSettled([
      repository.admitIdentity({
        providerSubject: "user_binding1",
        verifiedEmail: "owner@example.com",
        workosSessionId: "session_binding1",
        desktopCodeChallenge: desktopChallenge,
        now,
      }),
      repository.admitIdentity({
        providerSubject: "user_binding2",
        verifiedEmail: "owner@example.com",
        workosSessionId: "session_binding2",
        desktopCodeChallenge: desktopChallenge,
        now,
      }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(AuthKitAdmissionDeniedError),
    });
    const counts = await pool.query<{ identities: number; handoffs: number }>(`
      SELECT
        (SELECT count(*)::integer FROM external_identities) AS identities,
        (SELECT count(*)::integer FROM authkit_handoffs) AS handoffs
    `);
    expect(counts.rows[0]).toEqual({ identities: 1, handoffs: 1 });
  });

  it("denies a mapped subject after an email mismatch or membership revocation", async () => {
    await seedOwner();
    await repository.admitIdentity({
      providerSubject: "user_stable1",
      verifiedEmail: "owner@example.com",
      workosSessionId: "session_stable1",
      desktopCodeChallenge: desktopChallenge,
      now,
    });

    await expect(
      repository.admitIdentity({
        providerSubject: "user_stable1",
        verifiedEmail: "other@example.com",
        workosSessionId: "session_stable2",
        desktopCodeChallenge: desktopChallenge,
        now: new Date(now.getTime() + 1),
      }),
    ).rejects.toBeInstanceOf(AuthKitAdmissionDeniedError);

    await identityRepository.upsertMembership({
      workspaceId,
      userId: ownerId,
      role: "owner",
      status: "revoked",
    });
    await expect(
      repository.admitIdentity({
        providerSubject: "user_stable1",
        verifiedEmail: "owner@example.com",
        workosSessionId: "session_stable3",
        desktopCodeChallenge: desktopChallenge,
        now: new Date(now.getTime() + 2),
      }),
    ).rejects.toBeInstanceOf(AuthKitAdmissionDeniedError);

    const counts = await pool.query<{ identities: number; handoffs: number }>(`
      SELECT
        (SELECT count(*)::integer FROM external_identities) AS identities,
        (SELECT count(*)::integer FROM authkit_handoffs) AS handoffs
    `);
    expect(counts.rows[0]).toEqual({ identities: 1, handoffs: 1 });
  });

  it("deduplicates WorkOS revocations and revokes every linked local session", async () => {
    await seedOwner();
    const first = await admitAndExchange({
      providerSubject: "user_revoke1",
      workosSessionId: "session_revoke1",
    });
    const second = await admitAndExchange({
      providerSubject: "user_revoke1",
      workosSessionId: "session_revoke1",
      at: new Date(now.getTime() + 1),
    });
    const processedAt = new Date(now.getTime() + 2);

    expect(
      await repository.applyWorkOSSessionRevokedEvent({
        eventId: "event_revoke1",
        workosSessionId: "session_revoke1",
        occurredAt: now,
        now: processedAt,
      }),
    ).toBe(true);
    expect(
      await repository.applyWorkOSSessionRevokedEvent({
        eventId: "event_revoke1",
        workosSessionId: "session_revoke1",
        occurredAt: now,
        now: new Date(processedAt.getTime() + 1),
      }),
    ).toBe(false);
    expect(
      await identityRepository.findDeviceSessionByTokenHash(hashToken(first.token)),
    ).toBeNull();
    expect(
      await identityRepository.findDeviceSessionByTokenHash(hashToken(second.token)),
    ).toBeNull();
    const revoked = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM device_sessions
        WHERE workos_session_id IS NULL AND revoked_at = $1`,
      [processedAt],
    );
    expect(revoked.rows[0]?.count).toBe(2);
    expect((await pool.query("SELECT 1 FROM workos_events")).rowCount).toBe(1);

    const lateHandoff = await repository.admitIdentity({
      providerSubject: "user_revoke1",
      verifiedEmail: "owner@example.com",
      workosSessionId: "session_revoke1",
      desktopCodeChallenge: desktopChallenge,
      now: new Date(processedAt.getTime() + 2),
    });
    await expect(
      repository.exchangeHandoff({
        handoffCode: lateHandoff.handoffCode,
        codeVerifier: desktopVerifier,
        label: null,
        now: new Date(processedAt.getTime() + 2),
      }),
    ).rejects.toBeInstanceOf(AuthKitCredentialRejectedError);
  });

  it("reconciles only exact active snapshot rows and preserves later sessions", async () => {
    await seedOwner();
    const first = await admitAndExchange({
      providerSubject: "user_reconcile1",
      workosSessionId: "session_reconcileactive1",
    });
    const ended = await admitAndExchange({
      providerSubject: "user_reconcile1",
      workosSessionId: "session_reconcileended1",
      at: new Date(now.getTime() + 1),
    });

    const snapshot = await repository.listActiveAuthKitDeviceSessions(new Date(now.getTime() + 2));
    expect(
      snapshot
        .map(({ providerSubject, workosSessionId }) => ({
          providerSubject,
          workosSessionId,
        }))
        .sort((left, right) => left.workosSessionId.localeCompare(right.workosSessionId)),
    ).toEqual([
      {
        providerSubject: "user_reconcile1",
        workosSessionId: "session_reconcileactive1",
      },
      {
        providerSubject: "user_reconcile1",
        workosSessionId: "session_reconcileended1",
      },
    ]);
    const endedSnapshot = snapshot.find(
      (session) => session.workosSessionId === "session_reconcileended1",
    );
    expect(endedSnapshot).toBeDefined();

    const later = await admitAndExchange({
      providerSubject: "user_reconcile1",
      workosSessionId: "session_reconcilelater1",
      at: new Date(now.getTime() + 3),
    });
    const reconciledAt = new Date(now.getTime() + 4);
    await expect(
      repository.revokeAuthKitDeviceSessions(
        [endedSnapshot!.deviceSessionId, endedSnapshot!.deviceSessionId],
        reconciledAt,
      ),
    ).resolves.toBe(1);

    await expect(
      identityRepository.findDeviceSessionByTokenHash(hashToken(first.token)),
    ).resolves.not.toBeNull();
    await expect(
      identityRepository.findDeviceSessionByTokenHash(hashToken(ended.token)),
    ).resolves.toBeNull();
    await expect(
      identityRepository.findDeviceSessionByTokenHash(hashToken(later.token)),
    ).resolves.not.toBeNull();
    const rows = await pool.query<{
      token_hash: Buffer;
      workos_session_id: string | null;
      revoked_at: Date | null;
    }>(
      `SELECT token_hash, workos_session_id, revoked_at
         FROM device_sessions
        ORDER BY created_at, id`,
    );
    expect(
      rows.rows.map((row) => ({
        tokenHash: row.token_hash.toString("hex"),
        workosSessionId: row.workos_session_id,
        revokedAt: row.revoked_at,
      })),
    ).toEqual([
      {
        tokenHash: hashToken(first.token).toString("hex"),
        workosSessionId: "session_reconcileactive1",
        revokedAt: null,
      },
      {
        tokenHash: hashToken(ended.token).toString("hex"),
        workosSessionId: null,
        revokedAt: reconciledAt,
      },
      {
        tokenHash: hashToken(later.token).toString("hex"),
        workosSessionId: "session_reconcilelater1",
        revokedAt: null,
      },
    ]);
  });

  it("revokes linked sessions and purges provider state before server rollback", async () => {
    await seedOwner();
    await repository.createTransaction({
      providerState: "provider-state-value-that-is-long-enough-rollback",
      providerCodeVerifier: "provider-verifier-value-that-is-long-enough-rollback",
      desktopCodeChallenge: desktopChallenge,
      desktopState: "R".repeat(43),
      desktopAuthVariant: "production",
      expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
    });
    await admitAndExchange({
      providerSubject: "user_rollback1",
      workosSessionId: "session_rollback1",
    });
    await admitAndExchange({
      providerSubject: "user_rollback1",
      workosSessionId: "session_rollback2",
      at: new Date(now.getTime() + 1),
    });
    await admitAndExchange({
      providerSubject: "user_rollback1",
      workosSessionId: "session_alreadyrevoked1",
      at: new Date(now.getTime() + 2),
    });
    const alreadyRevokedAt = new Date(now.getTime() + 3);
    await repository.applyWorkOSSessionRevokedEvent({
      eventId: "event_alreadyrevoked1",
      workosSessionId: "session_alreadyrevoked1",
      occurredAt: alreadyRevokedAt,
      now: alreadyRevokedAt,
    });
    const magicLinkToken = "m".repeat(43);
    await identityRepository.insertDeviceSession({
      id: randomUUID(),
      userId: ownerId,
      tokenHash: hashToken(magicLinkToken),
      label: "Magic-link session",
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    });

    const rollbackAt = new Date(now.getTime() + 4);
    await expect(prepareAuthKitRollback(pool, rollbackAt)).resolves.toEqual({
      active: 2,
      revoked: 2,
      transactions: 1,
      handoffs: 3,
      events: 1,
      sessionLinks: 2,
    });
    await expect(prepareAuthKitRollback(pool, new Date(now.getTime() + 5))).resolves.toEqual({
      active: 0,
      revoked: 0,
      transactions: 0,
      handoffs: 0,
      events: 0,
      sessionLinks: 0,
    });

    const counts = await pool.query<{
      active_authkit: number;
      revoked_authkit: number;
      revoked_unlinked: number;
      active_magic_link: number;
      transactions: number;
      handoffs: number;
      events: number;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE workos_session_id IS NOT NULL AND revoked_at IS NULL
         )::integer AS active_authkit,
         count(*) FILTER (
           WHERE workos_session_id IS NOT NULL AND revoked_at IS NOT NULL
         )::integer AS revoked_authkit,
         count(*) FILTER (
           WHERE workos_session_id IS NULL AND revoked_at IS NOT NULL
         )::integer AS revoked_unlinked,
         count(*) FILTER (
           WHERE workos_session_id IS NULL AND revoked_at IS NULL
         )::integer AS active_magic_link,
         (SELECT count(*)::integer FROM authkit_transactions) AS transactions,
         (SELECT count(*)::integer FROM authkit_handoffs) AS handoffs,
         (SELECT count(*)::integer FROM workos_events) AS events
       FROM device_sessions`,
    );
    expect(counts.rows[0]).toEqual({
      active_authkit: 0,
      revoked_authkit: 0,
      revoked_unlinked: 3,
      active_magic_link: 1,
      transactions: 0,
      handoffs: 0,
      events: 0,
    });
    expect(
      await identityRepository.findDeviceSessionByTokenHash(hashToken(magicLinkToken)),
    ).not.toBeNull();
    const revokedTimestamps = await pool.query<{ revoked_at: Date; count: number }>(
      `SELECT revoked_at, count(*)::integer AS count
         FROM device_sessions
        WHERE workos_session_id IS NULL AND revoked_at IS NOT NULL
        GROUP BY revoked_at
        ORDER BY revoked_at`,
    );
    expect(revokedTimestamps.rows).toEqual([
      { revoked_at: alreadyRevokedAt, count: 1 },
      { revoked_at: rollbackAt, count: 2 },
    ]);
  });
});
