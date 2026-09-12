import { describe, expect, it } from "vitest";

import { hardFailWithoutRequiredTestDatabase } from "./require-test-database.mjs";

describe("hardFailWithoutRequiredTestDatabase", () => {
  it("does nothing when the database is not required", () => {
    expect(() => hardFailWithoutRequiredTestDatabase({})).not.toThrow();
    expect(() =>
      hardFailWithoutRequiredTestDatabase({ HYPE_COMMS_REQUIRE_TEST_DATABASE: "" }),
    ).not.toThrow();
    expect(() => hardFailWithoutRequiredTestDatabase({ CI: "true" })).not.toThrow();
  });

  it("does nothing when required and the database URL is configured", () => {
    expect(() =>
      hardFailWithoutRequiredTestDatabase({
        HYPE_COMMS_REQUIRE_TEST_DATABASE: "1",
        HYPE_COMMS_TEST_DATABASE_URL: "postgresql://hype_comms:pw@127.0.0.1:55432/hype_comms_test",
      }),
    ).not.toThrow();
  });

  it("fails loudly when required but the database URL is missing or blank", () => {
    expect(() =>
      hardFailWithoutRequiredTestDatabase({ HYPE_COMMS_REQUIRE_TEST_DATABASE: "1" }),
    ).toThrow(/HYPE_COMMS_REQUIRE_TEST_DATABASE.*HYPE_COMMS_TEST_DATABASE_URL/s);
    expect(() =>
      hardFailWithoutRequiredTestDatabase({
        HYPE_COMMS_REQUIRE_TEST_DATABASE: "1",
        HYPE_COMMS_TEST_DATABASE_URL: "   ",
      }),
    ).toThrow(/HYPE_COMMS_REQUIRE_TEST_DATABASE.*HYPE_COMMS_TEST_DATABASE_URL/s);
  });
});
