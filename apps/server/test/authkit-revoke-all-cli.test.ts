import { Writable } from "node:stream";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  AUTHKIT_REVOKE_ALL_CONFIRMATION,
  runAuthKitRevokeAllCli,
  type AuthKitRevokeAllCliOutput,
} from "../src/modules/identity/authkit-revoke-all-cli.js";

class TestOutput {
  stdout = "";
  stderr = "";

  readonly streams: AuthKitRevokeAllCliOutput = {
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

describe("AuthKit revoke-all CLI", () => {
  it("refuses database access without the exact explicit confirmation", async () => {
    for (const arguments_ of [
      [],
      ["--confirm", `${AUTHKIT_REVOKE_ALL_CONFIRMATION}!`],
      ["--confirm", AUTHKIT_REVOKE_ALL_CONFIRMATION, "extra"],
    ]) {
      const output = new TestOutput();

      await expect(runAuthKitRevokeAllCli(arguments_, {}, output.streams)).resolves.toBe(1);
      expect(output.stdout).toBe("");
      expect(output.stderr).toContain("Exact confirmation is required");
      expect(output.stderr).toContain(AUTHKIT_REVOKE_ALL_CONFIRMATION);
    }
  });

  it("needs only PostgreSQL configuration after exact confirmation", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            active: 3,
            revoked: 3,
            transactions: 2,
            handoffs: 1,
            events: 4,
            session_links: 5,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: null, rows: [] });
    const release = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
      end,
    } as unknown as Pool;
    const createDatabasePool = vi.fn(() => pool);
    const output = new TestOutput();
    const now = new Date("2026-08-11T21:00:00.000Z");

    await expect(
      runAuthKitRevokeAllCli(
        ["--confirm", AUTHKIT_REVOKE_ALL_CONFIRMATION],
        {
          HMM_DATABASE_URL: "postgres://hmm:secret@postgres/hmm_chat",
          HMM_DATABASE_POOL_SIZE: "3",
          // Deliberately incomplete unrelated settings must not block the emergency path.
          WORKOS_API_KEY: "unavailable-provider-credential",
          HMM_SMTP_URL: "not-a-valid-smtp-url",
        },
        output.streams,
        { createDatabasePool, now: () => now },
      ),
    ).resolves.toBe(0);

    expect(createDatabasePool).toHaveBeenCalledWith({
      url: "postgres://hmm:secret@postgres/hmm_chat",
      poolSize: 3,
    });
    expect(query.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN",
      expect.stringContaining("linked_authkit_sessions"),
      "COMMIT",
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([now]);
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("found: 3");
    expect(output.stdout).toContain("revoked now: 3");
    expect(output.stdout).toContain("links removed: 5");
    expect(output.stdout).toContain("transactions=2 handoffs=1 events=4");
  });

  it("validates only a PostgreSQL URL and bounded pool size before connecting", async () => {
    for (const environment of [
      { HMM_DATABASE_URL: "https://database.example/hmm" },
      { HMM_DATABASE_URL: "postgres://hmm@postgres/hmm", HMM_DATABASE_POOL_SIZE: "0" },
      { HMM_DATABASE_URL: "postgres://hmm@postgres/hmm", HMM_DATABASE_POOL_SIZE: "101" },
      { HMM_DATABASE_URL: "postgres://hmm@postgres/hmm", HMM_DATABASE_POOL_SIZE: "1.5" },
    ]) {
      const createDatabasePool = vi.fn();
      const output = new TestOutput();

      await expect(
        runAuthKitRevokeAllCli(
          ["--confirm", AUTHKIT_REVOKE_ALL_CONFIRMATION],
          environment,
          output.streams,
          { createDatabasePool },
        ),
      ).resolves.toBe(1);
      expect(createDatabasePool).not.toHaveBeenCalled();
      expect(output.stderr).toMatch(/PostgreSQL URL|integer from 1 through 100/);
    }
  });
});
