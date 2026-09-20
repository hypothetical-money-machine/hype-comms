import { apiErrorEnvelopeSchema } from "@hype-comms/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { DomainError, type DomainErrorKind } from "../src/domain-errors.js";
import { ApiError, registerErrorHandling } from "../src/errors.js";

const applications: ReturnType<typeof Fastify>[] = [];

function rejectingApplication(error: Error) {
  const app = Fastify({ genReqId: () => "boundary-request" });
  registerErrorHandling(app);
  app.get("/operation", () => {
    throw error;
  });
  applications.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("domain errors at the HTTP boundary", () => {
  it.each([
    ["invalid_input", 400, "BAD_REQUEST", "Invalid history cursor"],
    ["authentication_required", 401, "UNAUTHORIZED", "Authentication required"],
    ["access_denied", 403, "FORBIDDEN", "Only the author can retract this message"],
    ["not_found", 404, "NOT_FOUND", "Thread not found"],
    ["conflict", 409, "CONFLICT", "The task changed on another device"],
    ["sync_position_expired", 410, "CURSOR_EXPIRED", "The sync cursor has expired"],
    ["unavailable", 503, "SERVICE_UNAVAILABLE", "Workspace protocol cutover has not completed"],
    ["integrity_failure", 500, "INTERNAL_ERROR", "Stored file failed its integrity check"],
  ] satisfies [DomainErrorKind, number, string, string][])(
    "preserves the %s response consumed by existing clients",
    async (kind, status, code, message) => {
      const failure = new DomainError(kind, message);
      const response = await rejectingApplication(failure).inject("/operation");

      expect(response.statusCode).toBe(status);
      expect(apiErrorEnvelopeSchema.parse(response.json())).toEqual({
        error: { code, message, requestId: "boundary-request" },
      });
      expect(failure).not.toHaveProperty("statusCode");
      expect(failure).not.toHaveProperty("code");
    },
  );

  it("keeps route and identity errors with their declared details", async () => {
    const details = [{ field: "email", issue: "Email is required" }];
    const response = await rejectingApplication(
      new ApiError(400, "BAD_REQUEST", "Invalid request", details),
    ).inject("/operation");

    expect(response.statusCode).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(response.json())).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Invalid request",
        requestId: "boundary-request",
        details,
      },
    });
  });

  it("does not expose an unexpected exception as a handled domain failure", async () => {
    const error = Object.assign(new Error("Private database detail"), { kind: "not_found" });
    const response = await rejectingApplication(error).inject("/operation");

    expect(response.statusCode).toBe(500);
    expect(apiErrorEnvelopeSchema.parse(response.json())).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId: "boundary-request",
      },
    });
  });
});
