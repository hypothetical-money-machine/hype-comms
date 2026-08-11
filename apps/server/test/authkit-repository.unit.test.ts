import { createHash } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  AuthKitRepository,
  deriveAuthKitPkceCodeChallenge,
} from "../src/modules/identity/authkit-repository.js";

const providerState = "provider-state-value-that-is-long-enough-123";
const providerVerifier = "provider-verifier-value-that-is-long-enough-123";
const desktopVerifier = "desktop-verifier-value-that-is-long-enough-1234";
const desktopState = "D".repeat(43);

function queryOnlyPool(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool;
}

function transactionPool(query: ReturnType<typeof vi.fn>, release: ReturnType<typeof vi.fn>): Pool {
  return {
    connect: vi.fn().mockResolvedValue({ query, release }),
  } as unknown as Pool;
}

describe("AuthKitRepository crypto boundary", () => {
  it("requires an exact 256-bit AES key", () => {
    const pool = queryOnlyPool(vi.fn());

    expect(() => new AuthKitRepository(pool, Buffer.alloc(31))).toThrow(/exactly 32 bytes/);
    expect(() => new AuthKitRepository(pool, Buffer.alloc(33))).toThrow(/exactly 32 bytes/);
    expect(() => new AuthKitRepository(pool, Buffer.alloc(32))).not.toThrow();
  });

  it("derives the RFC 7636 S256 example challenge", () => {
    expect(deriveAuthKitPkceCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("stores only a SHA-256 state hash and AES-GCM encrypted provider verifier", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const repository = new AuthKitRepository(queryOnlyPool(query), Buffer.alloc(32, 7));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1_000);
    const desktopCodeChallenge = deriveAuthKitPkceCodeChallenge(desktopVerifier);

    await repository.createTransaction({
      providerState,
      providerCodeVerifier: providerVerifier,
      desktopCodeChallenge,
      desktopState,
      expiresAt,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const parameters = query.mock.calls[0]?.[1] as unknown[];
    expect(parameters[1]).toEqual(createHash("sha256").update(providerState).digest());
    expect(parameters[2]).toBeInstanceOf(Buffer);
    expect((parameters[2] as Buffer).byteLength).toBe(12);
    expect(parameters[3]).toBeInstanceOf(Buffer);
    expect((parameters[3] as Buffer).toString("utf8")).not.toContain(providerVerifier);
    expect(parameters[4]).toBeInstanceOf(Buffer);
    expect((parameters[4] as Buffer).byteLength).toBe(16);
    expect(parameters).not.toContain(providerState);
    expect(parameters).not.toContain(providerVerifier);
    expect(parameters.slice(5)).toEqual([desktopCodeChallenge, desktopState, expiresAt]);
  });

  it("rejects malformed provider and desktop binding material before persistence", async () => {
    const query = vi.fn();
    const repository = new AuthKitRepository(queryOnlyPool(query), Buffer.alloc(32, 7));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1_000);

    await expect(
      repository.createTransaction({
        providerState: "short",
        providerCodeVerifier: providerVerifier,
        desktopCodeChallenge: deriveAuthKitPkceCodeChallenge(desktopVerifier),
        desktopState,
        expiresAt,
      }),
    ).rejects.toThrow(/OAuth state/);
    await expect(
      repository.createTransaction({
        providerState,
        providerCodeVerifier: "not-a-verifier",
        desktopCodeChallenge: deriveAuthKitPkceCodeChallenge(desktopVerifier),
        desktopState,
        expiresAt,
      }),
    ).rejects.toThrow(/code verifier/);
    expect(query).not.toHaveBeenCalled();
  });

  it("deletes expired auth state and webhook dedupe rows after 30 days", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ transactions: 3, handoffs: 2, events: 4, sessions: 5 }],
    });
    const repository = new AuthKitRepository(queryOnlyPool(query), Buffer.alloc(32, 7));
    const now = new Date("2026-08-11T20:00:00.000Z");

    await expect(repository.deleteExpiredState(now)).resolves.toEqual({
      transactions: 3,
      handoffs: 2,
      events: 4,
      sessions: 5,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("DELETE FROM authkit_transactions");
    expect(query.mock.calls[0]?.[0]).toContain("DELETE FROM authkit_handoffs");
    expect(query.mock.calls[0]?.[0]).toContain("DELETE FROM workos_events");
    expect(query.mock.calls[0]?.[0]).toContain("SET revoked_at = COALESCE(revoked_at, $1)");
    expect(query.mock.calls[0]?.[0]).toContain("workos_session_id = NULL");
    expect(query.mock.calls[0]?.[1]).toEqual([now, new Date("2026-07-12T20:00:00.000Z")]);
  });

  it("transactionally revokes only active AuthKit-created local sessions", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ active: 4, revoked: 4 }] })
      .mockResolvedValueOnce({ rowCount: null, rows: [] });
    const release = vi.fn();
    const repository = new AuthKitRepository(transactionPool(query, release), Buffer.alloc(32, 7));
    const now = new Date("2026-08-11T20:00:00.000Z");

    await expect(repository.revokeAllActiveAuthKitSessions(now)).resolves.toEqual({
      active: 4,
      revoked: 4,
    });
    expect(query.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN",
      expect.stringContaining("WITH active_authkit_sessions AS MATERIALIZED"),
      "COMMIT",
    ]);
    const statement = query.mock.calls[1]?.[0] as string;
    expect(statement).toContain("workos_session_id IS NOT NULL");
    expect(statement).toContain("revoked_at IS NULL");
    expect(query.mock.calls[1]?.[1]).toEqual([now]);
    expect(release).toHaveBeenCalledOnce();
  });
});
