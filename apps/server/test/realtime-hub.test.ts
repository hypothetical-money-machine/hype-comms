import { EventEmitter } from "node:events";

import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RealtimeEventHub } from "../src/modules/realtime/hub.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "10000000-0000-4000-8000-000000000002";

/** The settle halves of a LISTEN query the fake is holding open. */
interface HeldListen {
  resolve: (result: { rows: never[] }) => void;
  reject: (error: Error) => void;
}

/** Mirrors the surface `RealtimeEventHub` uses, including pg's throw on a double release. */
class FakePoolClient extends EventEmitter {
  readonly queries: string[] = [];
  readonly releases: unknown[] = [];
  /** When true, LISTEN stays in flight until one of the settle helpers below is called. */
  holdListen = false;
  #heldListen: HeldListen | null = null;

  async query(text: string): Promise<{ rows: never[] }> {
    this.queries.push(text);
    if (this.holdListen && text.startsWith("LISTEN ")) {
      return new Promise<{ rows: never[] }>((resolve, reject) => {
        this.#heldListen = { resolve, reject };
      });
    }
    return { rows: [] };
  }

  /**
   * Kill the connection the way pg does: `Client._handleErrorEvent` emits `error` synchronously
   * from the socket callback and only afterwards rejects the queries already in flight. Returns
   * `emit`'s result so a caller can prove the error was delivered to a listener.
   */
  failInFlightListen(error: Error): boolean {
    const { reject } = this.#takeHeldListen();
    const delivered = this.emit("error", error);
    reject(error);
    return delivered;
  }

  /**
   * Lose the connection just after LISTEN round-trips: pg settles the query and can then emit
   * `error` from the socket callback in the same turn. Resolving only queues the awaiting hub's
   * continuation, so the loss lands while the client is checked out but not yet adopted.
   */
  loseAfterInFlightListen(error: Error): boolean {
    const { resolve } = this.#takeHeldListen();
    resolve({ rows: [] });
    return this.emit("error", error);
  }

  /** Let a held LISTEN succeed with no failure at all. */
  finishInFlightListen(): void {
    this.#takeHeldListen().resolve({ rows: [] });
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
      channel: "hype_comms_events",
      payload: `${workspace}:${sequence}`,
    });
  }

  #takeHeldListen(): HeldListen {
    const held = this.#heldListen;
    if (held === null) throw new Error("No LISTEN query is in flight");
    this.#heldListen = null;
    return held;
  }
}

class FakePool {
  readonly clients: FakePoolClient[] = [];
  /** Applied to each client as it is checked out, like a pool handing back dead sockets. */
  holdListen = false;

  async connect(): Promise<PoolClient> {
    const client = new FakePoolClient();
    client.holdListen = this.holdListen;
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
    // A successful re-LISTEN wakes existing subscribers once so they catch up on the NOTIFYs
    // raised while the listener was down, so that wake is the first entry recorded below.
    await waitFor(() => pool.clients.length === 2 && notified.length === 1);
    const second = pool.clientAt(1);
    // A truthy emit proves the replacement client carries the fan-out listener, not just that
    // some earlier wake happened to land in the array.
    expect(second.notify(workspaceId, 42)).toBe(true);

    expect(second.listenCount()).toBe(1);
    expect(notified).toEqual(["event", "event"]);
  });

  it("survives a connection that dies while LISTEN is still in flight", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new FakePool();
    pool.holdListen = true;
    const hub = new RealtimeEventHub(pool.asPool(), { reconnectDelaysMs: [0] });
    hubs.push(hub);
    const started = hub.start();
    await waitFor(() => pool.clients.length === 1 && pool.clientAt(0).listenCount() === 1);
    const client = pool.clientAt(0);
    const failure = new Error("Connection terminated unexpectedly");

    // The pool drops its own idle error handler at checkout, and pg emits `error` from the socket
    // callback before the in-flight query rejects. A hub that only supervises the client after
    // LISTEN resolves therefore lets this raise ERR_UNHANDLED_ERROR and exit the server.
    expect(() => client.failInFlightListen(failure)).not.toThrow();

    await expect(started).rejects.toBe(failure);
    // Destroyed with its failure rather than handed back: a half-open socket must leave the pool.
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toBe(failure);

    // A failed LISTEN has to leave the hub clientless, or the idempotence guard in #listen turns
    // every later start() and reconnect tick into a silent no-op.
    pool.holdListen = false;
    await hub.start();
    expect(pool.clients).toHaveLength(2);
    expect(pool.clientAt(1).listenCount()).toBe(1);
  });

  it("never adopts a client lost after LISTEN resolved but before it took ownership", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new FakePool();
    pool.holdListen = true;
    const hub = new RealtimeEventHub(pool.asPool(), { reconnectDelaysMs: [0] });
    hubs.push(hub);
    const flushes: string[] = [];
    hub.subscribe(workspaceId, () => {
      flushes.push("flush");
    });
    const started = hub.start();
    await waitFor(() => pool.clients.length === 1 && pool.clientAt(0).listenCount() === 1);
    const client = pool.clientAt(0);
    const failure = new Error("Connection terminated unexpectedly");
    // The replacement must come up healthy, so stop holding LISTEN before the reconnect ticks.
    pool.holdListen = false;

    // pg settles the in-flight LISTEN and can then emit `error` before the awaiting hub resumes, so
    // the loss arrives while the hub still holds no client for the loss handler to match against.
    expect(client.loseAfterInFlightListen(failure)).toBe(true);
    await started;

    // Adopting it instead leaves the hub certain it is live: nothing released, no reconnect, and
    // every subscriber silent forever while each NOTIFY lands on a dead socket.
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toBe(failure);

    await waitFor(() => pool.clients.length === 2 && pool.clientAt(1).listenCount() === 1);
    const second = pool.clientAt(1);
    expect(second.notify(workspaceId, 44)).toBe(true);
    expect(flushes).toEqual(["flush"]);
  });

  it("hands back the spare client when two listener starts overlap", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new FakePool();
    pool.holdListen = true;
    const hub = new RealtimeEventHub(pool.asPool(), { reconnectDelaysMs: [0] });
    hubs.push(hub);

    // Two #listen() runs overlap in production when start() races a reconnect tick; a second
    // start() gets in the same way, because neither run has taken ownership of a client yet.
    const first = hub.start();
    await waitFor(() => pool.clients.length === 1 && pool.clientAt(0).listenCount() === 1);
    const second = hub.start();
    await waitFor(() => pool.clients.length === 2 && pool.clientAt(1).listenCount() === 1);

    pool.clientAt(1).finishInFlightListen();
    await second;
    pool.clientAt(0).finishInFlightListen();
    await first;

    // The losing run must give its client up instead of overwriting the live one: the loss handler
    // ignores a client the hub no longer holds, so nothing else would ever free either of them.
    expect(pool.clientAt(0).releases).toHaveLength(1);
    expect(pool.clientAt(1).releases).toHaveLength(0);
    expect(pool.clientAt(0).notify(workspaceId, 7)).toBe(false);
    expect(pool.clientAt(1).notify(workspaceId, 8)).toBe(true);
  });

  it("wakes existing subscribers once after a successful re-LISTEN so they catch up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new FakePool();
    const hub = new RealtimeEventHub(pool.asPool(), { reconnectDelaysMs: [0] });
    hubs.push(hub);
    const flushes: string[] = [];
    hub.subscribe(workspaceId, () => {
      flushes.push("flush");
    });

    await hub.start();
    expect(flushes).toEqual([]);

    pool.clientAt(0).emit("error", new Error("connection reset"));
    await waitFor(() => pool.clients.length === 2 && pool.clientAt(1).listenCount() === 1);

    // Every event published during the outage produced a NOTIFY nobody heard, yet each socket still
    // reports itself live and never polls, so the re-LISTEN must trigger the HTTP catch-up itself.
    await waitFor(() => flushes.length > 0);
    expect(flushes).toEqual(["flush"]);

    // The catch-up must not have replaced ordinary delivery on the replacement client.
    expect(pool.clientAt(1).notify(workspaceId, 43)).toBe(true);
    expect(flushes).toEqual(["flush", "flush"]);
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
