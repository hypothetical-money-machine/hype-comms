import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const discoveryArguments = [
  "-m",
  "unittest",
  "discover",
  "-s",
  "integrations/hermes-hype-comms",
  "-p",
  "test_*.py",
  "-v",
];
const candidates =
  process.platform === "win32"
    ? [
        ["py", ["-3"]],
        ["python", []],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];

for (const [command, prefixArguments] of candidates) {
  const result = spawnSync(command, [...prefixArguments, ...discoveryArguments], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT") continue;
  if (result.error !== undefined) {
    console.error(`Could not start ${command}: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
  break;
}

if (process.exitCode === undefined) {
  // The Node toolchain is the documented requirement for `npm run check`, so a missing
  // interpreter must not block the TypeScript suites that run after this one. CI sets `CI`,
  // where the Hermes suite is mandatory and a silent skip would hide a real regression.
  const message = "Python 3 is required to test the Hermes platform plugin.";
  if (process.env.CI !== undefined && process.env.CI !== "") {
    console.error(message);
    process.exitCode = 1;
  } else {
    console.warn(`${message} Skipping the Hermes platform plugin tests.`);
    process.exitCode = 0;
  }
}
