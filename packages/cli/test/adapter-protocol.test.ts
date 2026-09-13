import { describe, expect, it, vi } from "vitest";
import { executeCli } from "../src/cli.js";
import { testRuntime } from "./helpers.js";

describe("CLI adapter protocol", () => {
  it("rejects an unsupported adapter protocol before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtime = testRuntime({ fetch, homeDirectory: "/unused" });
    expect(
      await executeCli(["--adapter-protocol=2", "messages", "send", "anything", "--json"], runtime),
    ).toBe(6);
    // Exit 6, not the usage exit: the Hermes adapter reads a usage exit from a threaded send as
    // "the CLI refused --thread-root-id" and retries flat.
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "ADAPTER_UPGRADE_REQUIRED", retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("declares its adapter protocol without credentials or network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtime = testRuntime({ fetch, homeDirectory: "/unused" });
    expect(await executeCli(["--adapter-protocol=1", "adapter", "protocol"], runtime)).toBe(0);
    expect(JSON.parse(runtime.stdoutText())).toEqual({
      adapterProtocol: 1,
      kind: "result",
      data: { protocol: 1 },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
