import { describe, expect, it, vi } from "vitest";

import {
  VerifiedWorkOSWebhookProcessor,
  WorkOSWebhookRejectedError,
  WorkOSWebhookUnavailableError,
} from "../src/modules/identity/authkit-webhook.js";

const CREATED_AT = "2026-08-11T18:00:00.000Z";
const NOW = new Date("2026-08-11T18:01:00.000Z");
const CLIENT_ID = "client_test";

function revokedPayload(sessionId = "session_abc123", clientId = CLIENT_ID): string {
  return JSON.stringify({
    object: "event",
    id: "event_abc123",
    event: "session.revoked",
    created_at: CREATED_AT,
    context: { client_id: clientId },
    data: { object: "session", id: sessionId, user_id: "user_abc123" },
  });
}

function transformedEvent(sessionId = "session_abc123", clientId = CLIENT_ID) {
  return {
    id: "event_abc123",
    event: "session.revoked",
    createdAt: CREATED_AT,
    context: { client_id: clientId },
    data: { object: "session", id: sessionId, userId: "user_abc123" },
  };
}

function processor(
  options: {
    readonly event?: unknown;
    readonly processed?: boolean;
    readonly verificationError?: boolean;
    readonly storeError?: boolean;
  } = {},
) {
  const constructEvent = options.verificationError
    ? vi.fn(async () => {
        throw new Error("bad signature");
      })
    : vi.fn(async () => options.event ?? transformedEvent());
  const applyWorkOSSessionRevokedEvent = options.storeError
    ? vi.fn(async () => {
        throw new Error("database unavailable");
      })
    : vi.fn(async () => options.processed ?? true);
  return {
    constructEvent,
    applyWorkOSSessionRevokedEvent,
    subject: new VerifiedWorkOSWebhookProcessor({
      verifier: { constructEvent },
      clientId: CLIENT_ID,
      secret: "whsec_test",
      store: { applyWorkOSSessionRevokedEvent },
      now: () => NOW,
    }),
  };
}

describe("VerifiedWorkOSWebhookProcessor", () => {
  it("verifies and applies a session revocation exactly once", async () => {
    const fixture = processor();

    await expect(
      fixture.subject.process({ payload: revokedPayload(), signature: "signed" }),
    ).resolves.toBe("processed");
    expect(fixture.constructEvent).toHaveBeenCalledWith({
      payload: revokedPayload(),
      sigHeader: "signed",
      secret: "whsec_test",
      tolerance: 180_000,
    });
    expect(fixture.applyWorkOSSessionRevokedEvent).toHaveBeenCalledWith({
      eventId: "event_abc123",
      workosSessionId: "session_abc123",
      occurredAt: new Date(CREATED_AT),
      now: NOW,
    });
  });

  it("reports an already applied event as a successful duplicate", async () => {
    const fixture = processor({ processed: false });

    await expect(
      fixture.subject.process({ payload: revokedPayload(), signature: "signed" }),
    ).resolves.toBe("duplicate");
  });

  it("ignores signed event types outside the narrow revocation consumer", async () => {
    const payload = JSON.stringify({
      object: "event",
      id: "event_abc123",
      event: "user.updated",
      created_at: CREATED_AT,
      context: { client_id: CLIENT_ID },
      data: {},
    });
    const fixture = processor({
      event: {
        id: "event_abc123",
        event: "user.updated",
        createdAt: CREATED_AT,
        context: { client_id: CLIENT_ID },
        data: {},
      },
    });

    await expect(fixture.subject.process({ payload, signature: "signed" })).resolves.toBe(
      "ignored",
    );
    expect(fixture.applyWorkOSSessionRevokedEvent).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures and raw/transformed mismatches", async () => {
    await expect(
      processor({ verificationError: true }).subject.process({
        payload: revokedPayload(),
        signature: "invalid",
      }),
    ).rejects.toBeInstanceOf(WorkOSWebhookRejectedError);

    await expect(
      processor({ event: transformedEvent("session_different") }).subject.process({
        payload: revokedPayload(),
        signature: "signed",
      }),
    ).rejects.toBeInstanceOf(WorkOSWebhookRejectedError);
  });

  it("rejects events without the configured WorkOS client context", async () => {
    const withoutContext = JSON.parse(revokedPayload()) as Record<string, unknown>;
    delete withoutContext.context;

    await expect(
      processor({
        event: {
          ...transformedEvent(),
          context: undefined,
        },
      }).subject.process({ payload: JSON.stringify(withoutContext), signature: "signed" }),
    ).rejects.toBeInstanceOf(WorkOSWebhookRejectedError);
    await expect(
      processor({ event: transformedEvent("session_abc123", "client_other") }).subject.process({
        payload: revokedPayload("session_abc123", "client_other"),
        signature: "signed",
      }),
    ).rejects.toBeInstanceOf(WorkOSWebhookRejectedError);
    await expect(
      processor().subject.process({
        payload: revokedPayload("session_abc123", "client_other"),
        signature: "signed",
      }),
    ).rejects.toBeInstanceOf(WorkOSWebhookRejectedError);
  });

  it("turns storage failures into a retryable provider failure", async () => {
    await expect(
      processor({ storeError: true }).subject.process({
        payload: revokedPayload(),
        signature: "signed",
      }),
    ).rejects.toBeInstanceOf(WorkOSWebhookUnavailableError);
  });
});
