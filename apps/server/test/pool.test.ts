import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { withTransaction } from "../src/db/pool.js";

function fakeClient(commands: string[]): PoolClient {
  return {
    query: vi.fn(async (command: string) => {
      commands.push(command);
      return {};
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
}

describe("withTransaction", () => {
  it("retries an explicitly retryable transaction after PostgreSQL aborts a deadlock victim", async () => {
    const firstCommands: string[] = [];
    const secondCommands: string[] = [];
    const first = fakeClient(firstCommands);
    const second = fakeClient(secondCommands);
    const clients = [first, second];
    const pool = {
      connect: vi.fn(async () => {
        const client = clients.shift();
        if (client === undefined) throw new Error("Unexpected extra transaction attempt");
        return client;
      }),
    } as unknown as Pool;
    let attempts = 0;

    await expect(
      withTransaction(
        pool,
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error("deadlock victim"), { code: "40P01" });
          }
          return "committed";
        },
        { deadlockRetries: 1 },
      ),
    ).resolves.toBe("committed");

    expect(attempts).toBe(2);
    expect(firstCommands).toEqual(["BEGIN", "ROLLBACK"]);
    expect(secondCommands).toEqual(["BEGIN", "COMMIT"]);
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).toHaveBeenCalledOnce();
  });

  it("does not replay a transaction unless the caller explicitly opts in", async () => {
    const commands: string[] = [];
    const client = fakeClient(commands);
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const error = Object.assign(new Error("deadlock victim"), { code: "40P01" });

    await expect(withTransaction(pool, async () => Promise.reject(error))).rejects.toBe(error);
    expect(commands).toEqual(["BEGIN", "ROLLBACK"]);
    expect(pool.connect).toHaveBeenCalledOnce();
  });
});
