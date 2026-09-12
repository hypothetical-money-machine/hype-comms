import { deferred } from "./test-support/deferred";
import { describe, expect, it, vi } from "vitest";
import type { ChatSessionState } from "@hype-comms/contracts";
import { DesktopSessionLifecycle } from "./desktop-session-lifecycle";
import { WorkspaceSessionOwner } from "./workspace-session-owner";

const SIGNED_IN: ChatSessionState = {
  status: "signed-in",
  method: "email",
  name: "Alice",
  email: "alice@example.test",
  userId: "alice",
  workspaceId: "workspace",
};
class Source {
  state: ChatSessionState = { status: "signed-out" };
  listeners = new Set<(state: ChatSessionState) => void>();
  subscribe = (listener: (state: ChatSessionState) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(state: ChatSessionState) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

describe("desktop session lifecycle", () => {
  it("starts resources before publishing restored login and keeps them on renewal", async () => {
    const source = new Source();
    source.state = SIGNED_IN;
    const create = vi.fn(() => ({ ready: true }));
    const sessions = new WorkspaceSessionOwner(create);
    const publish = vi.fn(() => expect(sessions.current?.resources.ready).toBe(true));
    const lifecycle = new DesktopSessionLifecycle({
      source,
      sessions,
      publish,
      reportFailure: vi.fn(),
    });
    expect(lifecycle.publishedState).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    await expect(lifecycle.readState()).resolves.toEqual(SIGNED_IN);
    source.set({ ...SIGNED_IN, name: "Alice updated" });
    await lifecycle.readState();
    expect(create).toHaveBeenCalledOnce();
    await lifecycle.dispose();
    expect(source.listeners.size).toBe(0);
  });

  it("awaits Claude suspension on passive sign-out before publishing or installing a new login", async () => {
    const source = new Source();
    source.state = SIGNED_IN;
    const suspended = deferred<void>();
    const suspendClaude = vi.fn(() => suspended.promise);
    const sessions = new WorkspaceSessionOwner((session) => {
      session.onDispose(suspendClaude);
      return {};
    });
    const publish = vi.fn<(state: ChatSessionState) => void>();
    const lifecycle = new DesktopSessionLifecycle({
      source,
      sessions,
      publish,
      reportFailure: vi.fn(),
    });
    await lifecycle.readState();
    const old = sessions.current!;
    source.set({ status: "signed-out" });
    expect(old.signal.aborted).toBe(true);
    expect(suspendClaude).toHaveBeenCalledOnce();
    expect(lifecycle.publishedState).toBeNull();
    const reading = lifecycle.readState();
    source.set({ ...SIGNED_IN, userId: "bob" });
    await Promise.resolve();
    expect(sessions.current).toBeNull();
    expect(publish).toHaveBeenCalledTimes(1);
    suspended.resolve();
    await expect(reading).resolves.toMatchObject({ userId: "bob" });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ userId: "bob" });
    const disposal = lifecycle.dispose();
    expect(lifecycle.dispose()).toBe(disposal);
    await disposal;
    source.set(SIGNED_IN);
    expect(sessions.current).toBeNull();
  });

  it("preserves authenticated offline context without creating an online transport", async () => {
    const source = new Source();
    const { status, ...context } = SIGNED_IN;
    expect(status).toBe("signed-in");
    source.state = {
      status: "session-unavailable",
      reason: "server_unreachable",
      message: "Offline",
      lastAuthenticatedSession: context,
    };
    const create = vi.fn(() => ({}));
    const lifecycle = new DesktopSessionLifecycle({
      source,
      sessions: new WorkspaceSessionOwner(create),
      publish: vi.fn(),
      reportFailure: vi.fn(),
    });
    await expect(lifecycle.readState()).resolves.toEqual(source.state);
    expect(create).not.toHaveBeenCalled();
    await lifecycle.dispose();
  });

  it("retires same-account authentication before credentials change and recovers from a failed exchange", async () => {
    const source = new Source();
    source.state = SIGNED_IN;
    const sessions = new WorkspaceSessionOwner(() => ({}));
    const lifecycle = new DesktopSessionLifecycle({
      source,
      sessions,
      publish: vi.fn(),
      reportFailure: vi.fn(),
    });
    await lifecycle.readState();
    const old = sessions.current!;
    const retiring = lifecycle.retire();
    expect(old.signal.aborted).toBe(true);
    await retiring;
    await expect(lifecycle.readState()).rejects.toThrow("changing");
    await lifecycle.refresh();
    await expect(lifecycle.readState()).resolves.toEqual(SIGNED_IN);
    expect(sessions.current?.scope.generation).toBeGreaterThan(old.scope.generation);
    await lifecycle.dispose();
  });

  it("holds state publication until authentication completes and ignores superseded results", async () => {
    const source = new Source();
    source.state = SIGNED_IN;
    const sessions = new WorkspaceSessionOwner(() => ({}));
    const publish = vi.fn<(state: ChatSessionState) => void>();
    const lifecycle = new DesktopSessionLifecycle({
      source,
      sessions,
      publish,
      reportFailure: vi.fn(),
    });
    await lifecycle.readState();
    const firstStarted = deferred<void>();
    const firstFinished = deferred<void>();
    const firstAuth = lifecycle.replaceAuthentication(async () => {
      firstStarted.resolve();
      await firstFinished.promise;
      source.set({ ...SIGNED_IN, userId: "bob" });
    });
    await firstStarted.promise;
    const firstRejected = expect(firstAuth).rejects.toMatchObject({ name: "AbortError" });
    const secondAuth = lifecycle.replaceAuthentication(async () => {
      // ChatSession serializes credential mutations; sign-out follows the queued exchange.
      await firstAuth.catch(() => undefined);
      source.set({ status: "signed-out" });
    });
    const reading = lifecycle.readState();
    firstFinished.resolve();
    await Promise.all([firstRejected, secondAuth]);
    await expect(reading).resolves.toEqual({ status: "signed-out" });
    expect(publish.mock.calls.map(([state]) => state)).toEqual([
      SIGNED_IN,
      { status: "signed-out" },
    ]);
    expect(sessions.current).toBeNull();
    await lifecycle.dispose();
  });

  it("does not let delayed offline sign-out clear a newer login", async () => {
    const source = new Source();
    const sessions = new WorkspaceSessionOwner(() => ({}));
    const lifecycle = new DesktopSessionLifecycle({
      source,
      sessions,
      publish: vi.fn(),
      reportFailure: vi.fn(),
    });
    await lifecycle.readState();
    const suspension = deferred<void>();
    const entered = deferred<void>();
    const clearCredentials = vi.fn();
    const oldSignOut = lifecycle.replaceAuthentication(async (assertCurrent) => {
      entered.resolve();
      await suspension.promise;
      assertCurrent();
      clearCredentials();
      source.set({ status: "signed-out" });
    });
    await entered.promise;
    const oldRejected = expect(oldSignOut).rejects.toMatchObject({ name: "AbortError" });
    await lifecycle.replaceAuthentication(async () => {
      source.set(SIGNED_IN);
    });
    suspension.resolve();
    await oldRejected;
    expect(clearCredentials).not.toHaveBeenCalled();
    await expect(lifecycle.readState()).resolves.toEqual(SIGNED_IN);
    await lifecycle.dispose();
  });

  it("restores resources after a failed auth attempt without deleting local state", async () => {
    const source = new Source();
    source.state = SIGNED_IN;
    const sessions = new WorkspaceSessionOwner(() => ({}));
    const lifecycle = new DesktopSessionLifecycle({
      source,
      sessions,
      publish: vi.fn(),
      reportFailure: vi.fn(),
    });
    await lifecycle.readState();
    const old = sessions.current!;
    await expect(
      lifecycle.replaceAuthentication(async () => {
        throw new Error("Login unavailable");
      }),
    ).rejects.toThrow("Login unavailable");
    expect(old.signal.aborted).toBe(true);
    await expect(lifecycle.readState()).resolves.toEqual(SIGNED_IN);
    expect(sessions.current?.scope.generation).toBeGreaterThan(old.scope.generation);
    await lifecycle.dispose();
  });

  it("prevents a delayed native dialog from starting local work in a new session", async () => {
    const source = new Source();
    source.state = SIGNED_IN;
    const sessions = new WorkspaceSessionOwner(() => ({}));
    const lifecycle = new DesktopSessionLifecycle({
      source,
      sessions,
      publish: vi.fn(),
      reportFailure: vi.fn(),
    });
    await lifecycle.readState();
    const selection = deferred<void>();
    const startClaude = vi.fn();
    const choosing = lifecycle.run(async (assertCurrent) => {
      await selection.promise;
      assertCurrent();
      startClaude();
    });
    await lifecycle.replaceAuthentication(async () => {
      source.set({ ...SIGNED_IN, userId: "bob" });
    });
    selection.resolve();
    await expect(choosing).rejects.toMatchObject({ name: "AbortError" });
    expect(startClaude).not.toHaveBeenCalled();
    await lifecycle.dispose();
  });

  it("does not publish a session whose resources failed to initialize", async () => {
    const source = new Source();
    source.state = SIGNED_IN;
    const sessions = new WorkspaceSessionOwner(() => {
      throw new Error("initialization failed");
    });
    const publish = vi.fn<(state: ChatSessionState) => void>();
    const reportFailure = vi.fn();
    const lifecycle = new DesktopSessionLifecycle({ source, sessions, publish, reportFailure });
    await expect(lifecycle.readState()).rejects.toThrow("initialization failed");
    expect(lifecycle.publishedState).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledOnce();
    await lifecycle.dispose();
  });
});
