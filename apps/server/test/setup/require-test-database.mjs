// Vitest setup for both server projects: an explicit required-database flag must never
// allow a missing URL. The integration project also validates its URL unconditionally in
// test/support/require-database.ts. scripts/test-postgres.mjs forces the flag for its child,
// and CI sets it for the database-backed full check. DB-free unit checks leave the flag unset.

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
