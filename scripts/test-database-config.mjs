export class NonTestDatabaseError extends Error {}

export function assertTestDatabaseName(name) {
  if (name === "" || !/(^|[_-])test($|[_-])/i.test(name)) {
    throw new NonTestDatabaseError(
      `Refusing to run PostgreSQL tests against non-test database ${name || "<empty>"}`,
    );
  }
}

export function requireTestDatabaseUrl(environment) {
  const databaseUrl = environment.HYPE_COMMS_TEST_DATABASE_URL?.trim() ?? "";
  if (databaseUrl === "") throw new Error("HYPE_COMMS_TEST_DATABASE_URL is required");
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("HYPE_COMMS_TEST_DATABASE_URL must be a PostgreSQL URL");
    }
    assertTestDatabaseName(decodeURIComponent(parsed.pathname.replace(/^\//, "")));
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("HYPE_COMMS_TEST_DATABASE_URL must be a PostgreSQL URL", { cause: error });
    }
    throw error;
  }
  return databaseUrl;
}
