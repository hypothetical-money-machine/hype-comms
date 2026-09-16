import { describe, expect, it, vi } from "vitest";

import { chooseAiChannelWorkspace } from "./choose-ai-channel-workspace";
import { deferred } from "./test-support/deferred";

function operations() {
  return {
    realpath: vi.fn<(path: string) => Promise<string>>().mockResolvedValue("/resolved/workspace"),
    stat: vi
      .fn<(path: string) => Promise<{ isDirectory(): boolean }>>()
      .mockResolvedValue({ isDirectory: () => true }),
    assertCurrent: vi.fn(() => undefined),
    chooseWorkspace: vi.fn(async (path: string) => ({ workspacePath: path })),
  };
}

describe("AI Channel workspace selection", () => {
  it("selects the resolved directory after checking the session", async () => {
    const dependencies = operations();
    dependencies.chooseWorkspace.mockImplementation(async (path) => {
      expect(dependencies.assertCurrent).toHaveBeenCalledOnce();
      return { workspacePath: path };
    });
    await expect(chooseAiChannelWorkspace("/selected/link", dependencies)).resolves.toEqual({
      workspacePath: "/resolved/workspace",
    });
    expect(dependencies.realpath).toHaveBeenCalledWith("/selected/link");
    expect(dependencies.stat).toHaveBeenCalledWith("/resolved/workspace");
  });

  it.each(["realpath", "stat"] as const)(
    "preserves cancellation while %s is pending and never changes the workspace",
    async (pendingOperation) => {
      const dependencies = operations();
      const entered = deferred<void>();
      const finish = deferred<void>();
      if (pendingOperation === "realpath") {
        dependencies.realpath.mockImplementation(async () => {
          entered.resolve();
          await finish.promise;
          return "/resolved/workspace";
        });
      } else {
        dependencies.stat.mockImplementation(async () => {
          entered.resolve();
          await finish.promise;
          return { isDirectory: () => true };
        });
      }
      const selection = chooseAiChannelWorkspace("/selected/link", dependencies);
      await entered.promise;
      const cancellation = new DOMException("Desktop session was replaced", "AbortError");
      dependencies.assertCurrent.mockImplementation(() => {
        throw cancellation;
      });
      const rejected = expect(selection).rejects.toBe(cancellation);
      finish.resolve();
      await rejected;
      expect(dependencies.chooseWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each(["realpath", "stat", "chooseWorkspace"] as const)(
    "keeps the unavailable-folder message and cause when %s fails",
    async (failedOperation) => {
      const dependencies = operations();
      const failure = new Error("Unavailable");
      dependencies[failedOperation].mockRejectedValue(failure);
      await expect(chooseAiChannelWorkspace("/selected/link", dependencies)).rejects.toMatchObject({
        message: "The selected AI Channel folder is unavailable",
        cause: failure,
      });
    },
  );

  it("rejects a regular file without changing the workspace", async () => {
    const dependencies = operations();
    dependencies.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(chooseAiChannelWorkspace("/selected/file", dependencies)).rejects.toThrow(
      "The selected AI Channel folder is unavailable",
    );
    expect(dependencies.chooseWorkspace).not.toHaveBeenCalled();
  });
});
