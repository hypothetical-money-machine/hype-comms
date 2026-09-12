import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

// Proves apps/server/test/setup/require-test-database.mjs is actually wired into
// apps/server/vitest.config.ts, not just unit-tested in isolation: this spawns a real Vitest run
// against one small test file with the guard's opt-in set and no database URL, and asserts the
// run fails loudly instead of the tests silently skipping.
test("fails the server suite before any test runs when a required test database is missing", () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const vitestEntrypoint = fileURLToPath(
    new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
  );

  const result = spawnSync(
    process.execPath,
    [vitestEntrypoint, "run", "--root", "apps/server", "test/config.test.ts"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        CI: "",
        HYPE_COMMS_REQUIRE_TEST_DATABASE: "1",
        HYPE_COMMS_TEST_DATABASE_URL: "",
      },
    },
  );

  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /HYPE_COMMS_REQUIRE_TEST_DATABASE/u);
  assert.match(output, /HYPE_COMMS_TEST_DATABASE_URL/u);
});
