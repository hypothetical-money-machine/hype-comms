import { describe, expect, it, vi } from "vitest";
import { deferred } from "./test-support/deferred";
import { suspendLocalAi } from "./suspend-local-ai";

describe("optional local AI suspension", () => {
  it("reports an unavailable controller without blocking account replacement", async () => {
    const report = vi.fn();
    await expect(
      suspendLocalAi(
        {
          suspend: async () => {
            throw new Error("not initialized");
          },
        },
        report,
      ),
    ).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledOnce();
    await expect(suspendLocalAi(null, report)).resolves.toBeUndefined();
  });

  it("waits for host teardown even when its eventual failure is reported", async () => {
    const teardown = deferred<never>();
    const report = vi.fn();
    let completed = false;
    const suspended = suspendLocalAi({ suspend: () => teardown.promise }, report).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    teardown.reject(new Error("worker failed"));
    await suspended;
    expect(report).toHaveBeenCalledOnce();
    expect(completed).toBe(true);
  });
});
