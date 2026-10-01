import { describe, expect, it, vi } from "vitest";
import { scopedWorkspaceSession } from "./scoped-workspace-session";
import { serverResponse } from "./test-support/server-response";
import { deferred } from "./test-support/deferred";
import { OwnedWorkspaceSession } from "./workspace-session-owner";
import { WorkspaceTransport } from "./workspace-transport";

function lifetime() {
  return new OwnedWorkspaceSession<{ transport: WorkspaceTransport }>({
    userId: "alice",
    workspaceId: "workspace",
    generation: 1,
  });
}

describe("scoped workspace networking", () => {
  it("cancels an obsolete response body before it can be consumed", async () => {
    const pending = deferred<Response>();
    const cancel = vi.fn();
    const session = lifetime();
    const chat = {
      fetch: vi.fn(() => pending.promise),
      markSignedOut: vi.fn(async () => true),
    };
    const scoped = scopedWorkspaceSession(chat, session);
    const response = scoped.fetch("https://chat.example/v2/members");
    await session.dispose();
    pending.resolve(new Response(new ReadableStream({ cancel })));
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    await expect(scoped.fetch("https://chat.example/v2/members")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(chat.fetch).toHaveBeenCalledOnce();
  });

  it("rejects a fully parsed response whose body finished after retirement", async () => {
    const session = lifetime();
    const reading = deferred<void>();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = serverResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
        pull() {
          reading.resolve();
        },
      }),
    );
    const scoped = scopedWorkspaceSession(
      { fetch: async () => response, markSignedOut: async () => true },
      session,
    );
    session.initialize(() => ({
      transport: new WorkspaceTransport("https://chat.example", scoped),
    }));
    const operation = session.run(({ transport }) => transport.members());
    await reading.promise;
    await session.dispose();
    body!.enqueue(new TextEncoder().encode('{"members":[]}'));
    body!.close();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts pending networking when its lifetime ends while the caller stays active", async () => {
    const session = lifetime();
    const caller = new AbortController();
    const entered = deferred<void>();
    const scoped = scopedWorkspaceSession(
      {
        fetch: async (_url, init = {}) => {
          const signal = init.signal;
          if (signal == null) throw new Error("Expected the network cancellation signal");
          entered.resolve();
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        markSignedOut: async () => true,
      },
      session,
    );
    const operation = scoped.fetch("https://chat.example/v2/members", { signal: caller.signal });
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    await session.dispose();
    await rejected;
    expect(caller.signal.aborted).toBe(false);
  });

  it("combines cancellation and defers the active-scope check until sign-out executes", async () => {
    const session = lifetime();
    const caller = new AbortController();
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(),
    );
    let signOutGuard: (() => boolean) | undefined;
    const scoped = scopedWorkspaceSession(
      {
        fetch,
        markSignedOut: async (_response, isCurrent) => {
          signOutGuard = isCurrent;
          return false;
        },
      },
      session,
    );
    await scoped.fetch("https://chat.example/v2/members", { signal: caller.signal });
    const signal = fetch.mock.calls[0]?.[1].signal;
    caller.abort();
    expect(signal?.aborted).toBe(true);
    await expect(scoped.markSignedOut(new Response(null, { status: 401 }))).resolves.toBe(false);
    expect(signOutGuard?.()).toBe(true);
    let callerIsCurrent = false;
    await expect(
      scoped.markSignedOut(new Response(null, { status: 401 }), () => callerIsCurrent),
    ).resolves.toBe(false);
    expect(signOutGuard?.()).toBe(false);
    callerIsCurrent = true;
    expect(signOutGuard?.()).toBe(true);
    await session.dispose();
    expect(signOutGuard?.()).toBe(false);
  });
});
