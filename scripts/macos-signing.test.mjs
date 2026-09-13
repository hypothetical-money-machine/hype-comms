import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupMacosSigning,
  configureMacosSigning,
  parseKeychainList,
  selectSigningIdentity,
} from "./macos-signing.mjs";

const team = "5LTMYWRTYR";
const identity = "a".repeat(40);
const original =
  '    "/Users/test/Library/Keychains/login.keychain-db"\n    "/tmp/keychain with spaces"\n';
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-macos-signing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const environment = {
    RUNNER_TEMP: directory,
    GITHUB_WORKSPACE: directory,
    GITHUB_ENV: path.join(directory, "environment"),
    HYPE_COMMS_MACOS_CSC_LINK: "base64:" + Buffer.from("test certificate").toString("base64"),
    HYPE_COMMS_MACOS_CSC_KEY_PASSWORD: "certificate-password",
    HYPE_COMMS_MACOS_APPLE_API_KEY_BASE64: Buffer.from("test notary key").toString("base64"),
    HYPE_COMMS_MACOS_APPLE_API_KEY_ID: "TESTKEY",
    HYPE_COMMS_MACOS_APPLE_API_ISSUER: "test-issuer",
    EXPECTED_MACOS_TEAM_ID: team,
  };
  const execute = (args) => {
    calls.push(args);
    if (args[0] === "list-keychains" && args.length === 3) return original;
    if (args[0] === "find-identity")
      return `  1) ${identity} "Developer ID Application: Test (${team})"\n     1 valid identities found\n`;
    return "";
  };
  return { environment, platform: "darwin", execute, calls, directory };
}

test("parses spaces and escaped quotes but rejects a partially parsed search list", () => {
  assert.deepEqual(parseKeychainList(original), [
    "/Users/test/Library/Keychains/login.keychain-db",
    "/tmp/keychain with spaces",
  ]);
  assert.deepEqual(parseKeychainList('  "/tmp/escaped\\"quote"\n'), ['/tmp/escaped"quote']);
  assert.deepEqual(parseKeychainList("\n"), []);
  for (const value of ['"/tmp/valid"\ninvalid', '"relative"', '"/tmp/line\\nbreak"'])
    assert.throws(() => parseKeychainList(value), /Could not parse/u);
});

test("selects one identity for the expected team", () => {
  const line = `1) ${identity} "Developer ID Application: Test (${team})"`;
  assert.equal(selectSigningIdentity(line, team), identity);
  assert.throws(() => selectSigningIdentity(`${line}\n${line}`, team), /exactly one/u);
  assert.throws(() => selectSigningIdentity(line, "OTHERTEAM0"), /exactly one/u);
});

test("uses the generated keychain password, writes private files, and restores the original list", async (t) => {
  const f = await fixture(t);
  await configureMacosSigning(f);
  const create = f.calls.find((call) => call[0] === "create-keychain");
  const partition = f.calls.find((call) => call[0] === "set-key-partition-list");
  assert.equal(partition[partition.indexOf("-k") + 1], create[2]);
  assert.notEqual(create[2], f.environment.HYPE_COMMS_MACOS_CSC_KEY_PASSWORD);
  for (const file of [
    "hype-comms-signing-certificate.p12",
    "hype-comms-notary-api-key.p8",
    "hype-comms-original-keychains.txt",
  ])
    assert.equal((await stat(path.join(f.directory, file))).mode & 0o777, 0o600);
  const exported = await readFile(f.environment.GITHUB_ENV, "utf8");
  assert.ok(exported.includes(`CSC_NAME=${identity}\n`));
  assert.ok(!exported.includes(create[2]) && !exported.includes("certificate-password"));
  await cleanupMacosSigning(f);
  assert.deepEqual(f.calls.filter((call) => call[0] === "list-keychains").at(-1), [
    "list-keychains",
    "-d",
    "user",
    "-s",
    ...parseKeychainList(original),
  ]);
  await assert.rejects(
    readFile(path.join(f.directory, "hype-comms-original-keychains.txt")),
    /ENOENT/u,
  );
  await cleanupMacosSigning(f);
});

test("preserves the recovery list and removes credentials after restoration failure", async (t) => {
  const f = await fixture(t);
  await configureMacosSigning(f);
  await assert.rejects(
    cleanupMacosSigning({
      ...f,
      execute: (args) => {
        if (args[0] === "list-keychains") throw new Error("restore failed");
        return f.execute(args);
      },
    }),
    /preserving.*manual/u,
  );
  assert.equal(
    await readFile(path.join(f.directory, "hype-comms-original-keychains.txt"), "utf8"),
    original,
  );
  for (const file of ["hype-comms-signing-certificate.p12", "hype-comms-notary-api-key.p8"])
    await assert.rejects(readFile(path.join(f.directory, file)), /ENOENT/u);
  await assert.rejects(configureMacosSigning(f), /Restore the previous/u);
  await cleanupMacosSigning(f);
});

test("recovers an interrupted setup and retains a malformed recovery record", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    configureMacosSigning({
      ...f,
      execute: (args) => {
        if (args[0] === "import") throw new Error("import failed");
        return f.execute(args);
      },
    }),
    /import failed/u,
  );
  await cleanupMacosSigning(f);
  await writeFile(
    path.join(f.directory, "hype-comms-original-keychains.txt"),
    '"/tmp/valid"\nbroken',
  );
  await assert.rejects(cleanupMacosSigning(f), /preserving/u);
  assert.ok(
    (await readFile(path.join(f.directory, "hype-comms-original-keychains.txt"), "utf8")).includes(
      "broken",
    ),
  );
});

test("retains recovery when the native restoration command is missing", async (t) => {
  const f = await fixture(t);
  await configureMacosSigning(f);
  await assert.rejects(
    cleanupMacosSigning({
      ...f,
      execute: (args) => {
        if (args[0] === "list-keychains")
          throw Object.assign(new Error("missing command"), { code: "ENOENT" });
        return f.execute(args);
      },
    }),
    /preserving.*manual/u,
  );
  assert.equal(
    await readFile(path.join(f.directory, "hype-comms-original-keychains.txt"), "utf8"),
    original,
  );
  await cleanupMacosSigning(f);
});
