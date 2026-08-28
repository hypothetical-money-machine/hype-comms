import { describe, expect, it } from "vitest";

import { deriveAgentWakeId } from "../src/wake-node.js";

describe("Node wake ID derivation", () => {
  it("hashes the canonical domain-separated logical wake key", () => {
    expect(
      deriveAgentWakeId({
        workspaceId: "10000000-0000-4000-8000-000000000003",
        agentUserId: "10000000-0000-4000-8000-000000000001",
        messageId: "10000000-0000-4000-8000-000000000005",
      }),
    ).toBe("29292c4a17d0880f0a441d36e3c4263dcb1cb2ebe51c562d365dc0ed6811c502");
  });
});
