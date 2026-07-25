import { EventEmitter } from "node:events";

import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RealtimeEventHub } from "../src/modules/realtime/hub.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "10000000-0000-4000-8000-000000000002";

/** Mirrors the surface `RealtimeEventHub` uses, including pg's throw on a double release. */
class FakePoolClient extends EventEmitter {
  readonly queries: string[] = [];
  readonly releases: unknown[] = [];

  async query(text: string): Promise<{ rows: never[] }> {
    this.queries.push(text);
    return { rows: [] };
  }

  release(error?: unknown): void {
    if (this.releases.length > 0) {
      throw new Error("Release called on a client which has already been released to the pool.");
    }
    this.releases.push(error);
  }

  listenCount(): number {
    return this.queries.filter((text) => text.startsWith("LISTEN ")).length;
  }

  notify(workspace: string, sequence: number): boolean {
    return this.emit("notification", {
      channel: "hmm_chat_events",
      payload: `${workspace}:${sequence}`,
    });
  }
}

class FakePool {
  readonly clients: FakePoolClient[] = [];

  async connect(): Promise<PoolClient> {
    const client = new FakePoolClient();
    this.clients.push(client);
    return client as unknown as PoolClient;
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }

  clientAt(index: number): FakePoolClient {
    const client = this.clients[index];
    if (client === undefined) throw new Error(`No pool client was checked out at ${index}`);
    return client;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the hub to settle");
    await delay(5);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const hubs: RealtimeEventHub[] = [];

afterEach(async () => {
  await Promise.all(hubs.splice(0).map(async (hub) => hub.close()));
  vi.restoreAllMocks();
});

async function startedHub(pool: FakePool, reconnectDelaysMs = [0]): Promise<RealtimeEventHub> {
  const hub = new RealtimeEventHub(pool.asPool(), { reconnectDelaysMs });
  hubs.push(hub);
  await hub.start();
  return hub;
}

describe("RealtimeEventHub listener supervision", () => {
  it("survives a LISTEN client error instead of crashing the process", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new FakePool();
    await startedHub(pool);
    const first = pool.clientAt(0);

    // Without an `error` listener on the checked-out client this throws ERR_UNHANDLED_ERROR,
    // which in production exits the server and drops every open WebSocket.
    const failListener = (): boolean => first.emit("error", new Error("connection terminated"));
    expect(failListener).not.toThrow();

    await waitFor(() => pool.clients.length === 2);
    expect(logged).toHaveBeenCalled();
    expect(first.releases).toHaveLength(1);
    expect(first.releases[0]).toBeInstanceOf(Error);
  });

  it("re-issues LISTEN and keeps delivering notifications after a listener failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new FakePool();
    const hub = await startedHub(pool);
    const notified: string[] = [];
    hub.subscribe(workspaceId, () => {
      notified.push("event");
    });

    pool.clientAt(0).emit("error", new Error("connection reset"));
    await waitFor(() => pool.clients.length === 2);
    const second = pool.clientAt(1);
    second.notify(workspaceId, 42);

    expect(second.listenCount()).toBe(1);
    expect(notified).toEqual(["event"]);
  });

  it("stops reconnecting once the hub is closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new FakePool();
    const hub = await startedHub(pool, [20]);

    pool.clientAt(0).emit("error", new Error("connection reset"));
    await hub.close();
    await delay(60);

    expect(pool.clients).toHaveLength(1);
  });
});

describe("RealtimeEventHub subscribe", () => {
  it("keeps another socket's fan-out alive when one socket unsubscribes twice", async () => {
    const pool = new FakePool();
    const hub = await startedHub(pool);
    const client = pool.clientAt(0);

    const firstSocket: string[] = [];
    const unsubscribeFirst = hub.subscribe(workspaceId, () => {
      firstSocket.push("event");
    });
    unsubscribeFirst();

    const secondSocket: string[] = [];
    hub.subscribe(workspaceId, () => {
      secondSocket.push("event");
    });
    // routes.ts used to tear down from both `close` and `error`, so a stale second call must not
    // evict the workspace entry the healthy connection now owns.
    unsubscribeFirst();

    client.notify(workspaceId, 7);

    expect(secondSocket).toEqual(["event"]);
    expect(firstSocket).toEqual([]);
  });

  it("ignores notifications for a workspace whose last subscriber unsubscribed twice", async () => {
    const pool = new FakePool();
    const hub = await startedHub(pool);
    const client = pool.clientAt(0);

    const received: string[] = [];
    const unsubscribe = hub.subscribe(otherWorkspaceId, () => {
      received.push("event");
    });
    unsubscribe();
    unsubscribe();

    expect(() => client.notify(otherWorkspaceId, 7)).not.toThrow();
    expect(received).toEqual([]);
  });
});
