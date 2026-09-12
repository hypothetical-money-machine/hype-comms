import { deferred } from "./test-support/deferred";
import { describe, expect, it, vi } from "vitest";
import { OwnedWorkspaceSession, WorkspaceSessionOwner } from "./workspace-session-owner";

const ALICE = { userId: "alice", workspaceId: "workspace" };
const BOB = { userId: "bob", workspaceId: "workspace" };

describe("workspace session ownership", () => {
  it("cancels immediately, awaits all cleanup, and installs only the latest identity", async () => {
    const cleanup = deferred<void>();
    const created: string[] = [];
    const owner = new WorkspaceSessionOwner((session) => {
      created.push(session.scope.userId);
      session.onDispose(() => cleanup.promise);
      return { id: session.scope.userId };
    });
    await owner.replace(ALICE);
    const first = owner.current!;
    const replacement = owner.replace(BOB);
    expect(first.signal.aborted).toBe(true);
    expect(owner.current).toBeNull();
    const latest = owner.replace(ALICE);
    await Promise.resolve();
    expect(created).toEqual(["alice"]);
    cleanup.resolve();
    await Promise.all([replacement, latest]);
    expect(created).toEqual(["alice", "alice"]);
    expect(owner.current?.scope.generation).toBeGreaterThan(first.scope.generation);
    await owner.dispose();
  });

  it("coalesces renewal and gives disposal a stable promise", async () => {
    const cleanup = vi.fn();
    const owner = new WorkspaceSessionOwner((session) => {
      session.onDispose(cleanup);
      return {};
    });
    const first = owner.replace(ALICE);
    expect(owner.replace({ ...ALICE })).toBe(first);
    await first;
    const session = owner.current;
    await owner.replace({ ...ALICE });
    expect(owner.current).toBe(session);
    const disposed = owner.dispose();
    expect(owner.dispose()).toBe(disposed);
    await disposed;
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(owner.replace(BOB)).rejects.toThrow("disposed");
  });

  it("rejects results completed after cancellation, even if the operation ignores abort", async () => {
    const result = deferred<string>();
    const session = new OwnedWorkspaceSession({ ...ALICE, generation: 1 });
    session.initialize(() => ({}));
    const response = session.run(() => result.promise);
    await session.dispose();
    result.resolve("old body");
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    await expect(session.run(() => "unused")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("attempts every cleanup and waits for asynchronous cleanup despite failures", async () => {
    const cleanup = deferred<void>();
    const events: string[] = [];
    const owner = new WorkspaceSessionOwner((session) => {
      session.onDispose(() => {
        events.push("async");
        return cleanup.promise;
      });
      session.onDispose(() => {
        events.push("failure");
        throw new Error("cleanup failed");
      });
      return {};
    });
    await owner.replace(ALICE);
    const replacement = owner.replace(BOB);
    const rejection = expect(replacement).rejects.toThrow("Workspace session cleanup failed");
    expect(events).toEqual(["failure", "async"]);
    expect(owner.current).toBeNull();
    cleanup.resolve();
    await rejection;
    expect(owner.current).toBeNull();
  });

  it("cleans partially initialized resources before reporting factory failure", async () => {
    const cleanup = vi.fn();
    const owner = new WorkspaceSessionOwner((session) => {
      session.onDispose(cleanup);
      throw new Error("initialization failed");
    });
    await expect(owner.replace(ALICE)).rejects.toThrow("initialization failed");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(owner.current).toBeNull();
    await owner.dispose();
  });

  it("retires resources superseded reentrantly during initialization", async () => {
    const cleanup = vi.fn();
    const owner: WorkspaceSessionOwner<object> = new WorkspaceSessionOwner((session) => {
      session.onDispose(cleanup);
      if (session.scope.userId === ALICE.userId) void owner.replace(BOB);
      return {};
    });
    await owner.replace(ALICE);
    await owner.ready;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(owner.current?.scope.userId).toBe(BOB.userId);
    await owner.dispose();
  });
});
