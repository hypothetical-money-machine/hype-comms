import { describe, expect, it } from "vitest";
import { parseBearerAuthorization } from "../src/http/bearer-authorization.js";

describe("Bearer authorization syntax", () => {
  it.each(["Bearer secret", "bearer secret", "BEARER\tsecret", "bEaReR \t  secret"])(
    "accepts %j",
    (header) => {
      expect(parseBearerAuthorization(header)).toEqual({ scheme: "bearer", token: "secret" });
    },
  );
  it.each([
    "Bearer",
    "Bearer ",
    "Bearer\t",
    "Bearer secret extra",
    "Bearer secret\t",
    "Bearer secret\n",
    "Bearer secret\r\n",
  ])("retains the scheme but rejects a malformed token in %j", (header) => {
    expect(parseBearerAuthorization(header)).toEqual({ scheme: "bearer", token: null });
  });
  it.each([undefined, "", "Basic secret", "BearerSecret", ["Bearer one", "Bearer two"]])(
    "does not classify %j as Bearer",
    (header) => {
      expect(parseBearerAuthorization(header)).toEqual({ scheme: "other", token: null });
    },
  );
});
