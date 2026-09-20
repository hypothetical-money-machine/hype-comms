// Global Vitest setup for the server workspace: hard-fail when HYPE_COMMS_REQUIRE_TEST_DATABASE
// is set but HYPE_COMMS_TEST_DATABASE_URL is not, instead of letting each test file silently skip
// its PostgreSQL-backed tests.
//
// This is opt-in through HYPE_COMMS_REQUIRE_TEST_DATABASE, not through CI: `npm run check` runs
// `npm test` (and therefore this workspace's Vitest suite) with CI set and without a database, so
// keying the guard on CI alone would fail that step. scripts/test-postgres.mjs sets
// HYPE_COMMS_REQUIRE_TEST_DATABASE for `npm run test:postgres`, and
// .github/workflows/ci.yml sets it for the "Run the complete PostgreSQL suite" step, which
// already provides the URL. If a future change drops the URL from that step, this guard turns
// the resulting silent skip into a hard failure instead.
//
// This module has no third-party imports (in particular, no `pg`), so every server test worker
// can load it cheaply as a Vitest setup file.

export function hardFailWithoutRequiredTestDatabase(environment = process.env) {
  const required =
    environment.HYPE_COMMS_REQUIRE_TEST_DATABASE !== undefined &&
    environment.HYPE_COMMS_REQUIRE_TEST_DATABASE !== "";
  if (!required) return;
  const databaseUrl = environment.HYPE_COMMS_TEST_DATABASE_URL?.trim() ?? "";
  if (databaseUrl !== "") return;
  throw new Error(
    "HYPE_COMMS_REQUIRE_TEST_DATABASE is set but HYPE_COMMS_TEST_DATABASE_URL is not: the " +
      "server test suite must not silently skip its PostgreSQL-backed tests. Set " +
      "HYPE_COMMS_TEST_DATABASE_URL or unset HYPE_COMMS_REQUIRE_TEST_DATABASE.",
  );
}

hardFailWithoutRequiredTestDatabase();
