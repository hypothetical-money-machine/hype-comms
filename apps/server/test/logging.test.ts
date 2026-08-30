import { describe, expect, it } from "vitest";

import { redactedRequestPath } from "../src/logging.js";

describe("request-log path redaction", () => {
  it("removes incoming webhook credentials while preserving ordinary route paths", () => {
    const token = `hype_comms_bot_${"a".repeat(43)}`;

    expect(redactedRequestPath(`/v1/webhooks/incoming/${token}`)).toBe(
      "/v1/webhooks/incoming/[REDACTED]",
    );
    expect(redactedRequestPath(`/v1/webhooks/incoming/${token}/unexpected?debug=true`)).toBe(
      "/v1/webhooks/incoming/[REDACTED]",
    );
    expect(redactedRequestPath("/v1/channels/example/messages?limit=50")).toBe(
      "/v1/channels/example/messages",
    );
  });
});
