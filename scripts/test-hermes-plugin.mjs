import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const plugin = "integrations/hermes-hype-comms";
const localPython = fileURLToPath(
  new URL(
    process.platform === "win32"
      ? "../.venv/hermes/Scripts/python.exe"
      : "../.venv/hermes/bin/python",
    import.meta.url,
  ),
);
const candidates =
  process.env.HYPE_COMMS_PYTHON !== undefined
    ? [[process.env.HYPE_COMMS_PYTHON, []]]
    : existsSync(localPython)
      ? [[localPython, []]]
      : process.platform === "win32"
        ? [
            ["py", ["-3"]],
            ["python", []],
          ]
        : [
            ["python3", []],
            ["python", []],
          ];
let interpreter;
for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, "--version"], { stdio: "ignore" });
  if (probe.error?.code === "ENOENT") continue;
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error(`Could not start Python interpreter ${command}`);
  }
  interpreter = { command, prefix };
  break;
}
if (interpreter === undefined) {
  throw new Error("Python 3.11 or newer is required for the mandatory Hermes checks.");
}
for (const args of [
  ["-m", "ruff", "check", "--config", `${plugin}/pyproject.toml`, plugin],
  ["-m", "mypy", "--config-file", `${plugin}/pyproject.toml`],
  ["-m", "unittest", "discover", "-s", plugin, "-p", "test_*.py", "-v"],
]) {
  const result = spawnSync(interpreter.command, [...interpreter.prefix, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "inherit",
  });
  if (result.error !== undefined || result.status !== 0) {
    console.error(
      "Hermes checks failed. Install requirements-dev.txt in .venv/hermes or set HYPE_COMMS_PYTHON to the prepared interpreter.",
    );
    process.exitCode = result.status || 1;
    break;
  }
}
