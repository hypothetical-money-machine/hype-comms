import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "pg";

const DEFAULT_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 500;

import {
  NonTestDatabaseError,
  assertTestDatabaseName,
  requireTestDatabaseUrl,
} from "./test-database-config.mjs";

export { requireTestDatabaseUrl } from "./test-database-config.mjs";

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function connectOnce(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    const result = await client.query("SELECT current_database() AS database_name");
    const name = result.rows[0]?.database_name;
    assertTestDatabaseName(typeof name === "string" ? name : "");
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function waitForPostgres(
  databaseUrl,
  {
    attempts = DEFAULT_ATTEMPTS,
    delayMs = DEFAULT_DELAY_MS,
    connect = connectOnce,
    sleep = delay,
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("attempts must be positive");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await connect(databaseUrl);
      return;
    } catch (error) {
      if (error instanceof NonTestDatabaseError) throw error;
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`PostgreSQL did not become ready after ${String(attempts)} attempts: ${reason}`);
}

async function runServerSuite(arguments_) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(
    npm,
    ["run", "test:integration", "--workspace", "@hype-comms/server", "--", ...arguments_],
    {
      cwd: new URL("..", import.meta.url),
      env: process.env,
      stdio: "inherit",
    },
  );
  const [code, signal] = await once(child, "close");
  if (signal !== null) throw new Error(`Server test suite terminated by ${signal}`);
  if (code !== 0) process.exitCode = code ?? 1;
}

async function main() {
  const databaseUrl = requireTestDatabaseUrl(process.env);
  process.stdout.write("==> waiting for the PostgreSQL test database\n");
  await waitForPostgres(databaseUrl);
  if (process.argv.length === 3 && process.argv[2] === "--ready") return;
  process.stdout.write("==> running PostgreSQL integration tests\n");
  await runServerSuite(process.argv.slice(2));
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
