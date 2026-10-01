import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(new URL("./test-hermes-plugin.mjs", import.meta.url));

async function runVerifier(t, versions, configuredPython) {
  const directory = await mkdtemp(path.join(tmpdir(), "hype-python-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = path.join(directory, "mock-python.cjs");
  const calls = path.join(directory, "calls.jsonl");
  await writeFile(
    preload,
    `
      const fs = require("node:fs");
      const childProcess = require("node:child_process");
      const { syncBuiltinESMExports } = require("node:module");
      const versions = ${JSON.stringify(versions)};
      const originalExists = fs.existsSync;
      fs.existsSync = value => String(value).includes(".venv") ? false : originalExists(value);
      childProcess.spawnSync = (command, args) => {
        fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command, args }) + "\\n");
        return {
          status: 0,
          stdout: args.at(-1) === "--version" ? versions[command] : "",
          stderr: "",
        };
      };
      syncBuiltinESMExports();
    `,
  );
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  delete env.HYPE_COMMS_PYTHON;
  if (configuredPython !== undefined) env.HYPE_COMMS_PYTHON = configuredPython;
  const result = spawnSync(process.execPath, [verifier], { env, encoding: "utf8" });
  const invocations = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { result, invocations };
}

test("rejects configured Python below 3.11 before any Hermes check runs", async (t) => {
  const { result, invocations } = await runVerifier(
    t,
    { "configured-python": "Python 3.10.20\n" },
    "configured-python",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Python 3\.11 or newer is required/u);
  assert.deepEqual(invocations, [{ command: "configured-python", args: ["--version"] }]);
});

test("falls back to a supported automatic interpreter after an older Python", async (t) => {
  const first = process.platform === "win32" ? "py" : "python3";
  const { result, invocations } = await runVerifier(t, {
    [first]: "Python 3.10.20\n",
    python: "Python 3.11.15\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(invocations[0].command, first);
  assert.equal(invocations[1].command, "python");
  assert.deepEqual(
    invocations.slice(2).map(({ command, args }) => [command, args[1]]),
    [
      ["python", "ruff"],
      ["python", "mypy"],
      ["python", "unittest"],
    ],
  );
});

test("runs all mandatory checks with configured Python 3.11", async (t) => {
  const { result, invocations } = await runVerifier(
    t,
    { "configured-python": "Python 3.11.15\n" },
    "configured-python",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    invocations.slice(1).map(({ command, args }) => [command, args[1]]),
    [
      ["configured-python", "ruff"],
      ["configured-python", "mypy"],
      ["configured-python", "unittest"],
    ],
  );
});

test("rejects an unrecognized Python version before running checks", async (t) => {
  const { result, invocations } = await runVerifier(
    t,
    { "configured-python": "unexpected version output\n" },
    "configured-python",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not determine Python version/u);
  assert.equal(invocations.length, 1);
});
