import { describe, expect, it } from "vitest";
import { WorkspaceRecovery, workspaceNeedsRecovery } from "./workspace-recovery";

describe("recovery ownership", () => {
  it("keeps a newer demand and unrelated blocked work when an old attempt completes", () => {
    const recovery = new WorkspaceRecovery(() => undefined);
    const old = recovery.begin("resync");
    const membership = recovery.begin("membership");
    recovery.block(membership, "Sign in to restore access");
    const newer = recovery.begin("resync");
    recovery.complete(old);
    recovery.block(old, "Late failure");
    expect(recovery.snapshot.map((work) => [work.key, work.status])).toEqual([
      ["resync", "pending"],
      ["membership", "blocked"],
    ]);
    recovery.complete(newer);
    expect(workspaceNeedsRecovery(recovery.snapshot)).toBe(true);
    expect(recovery.snapshot[0]?.reason).toBe("Sign in to restore access");
    recovery.complete(membership);
    expect(workspaceNeedsRecovery(recovery.snapshot)).toBe(false);
  });

  it("ignores old completions, phases and failures after session retirement", () => {
    const recovery = new WorkspaceRecovery(() => undefined);
    const old = recovery.begin("startup");
    recovery.reset();
    recovery.begin("startup");
    const snapshot = recovery.snapshot;
    recovery.advanceStartup(old, "realtime");
    recovery.block(old, "Old session failed");
    recovery.complete(old);
    expect(recovery.snapshot).toBe(snapshot);
    expect(recovery.startupPhase).toBe("metadata");
  });
});
