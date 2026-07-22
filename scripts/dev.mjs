import concurrently from "concurrently";

import { developmentNameUsage, parseDevelopmentName } from "./development-name.mjs";

function fail(message) {
  process.stderr.write(`${message}\nUsage: npm run dev -- ${developmentNameUsage}\n`);
  process.exitCode = 1;
}

const name = parseDevelopmentName(process.argv.slice(2));
if (name === null) {
  fail("A valid temporary chat identity is required.");
} else {
  const { result } = concurrently(
    [
      { command: "npm run dev:server", name: "server" },
      {
        command: "npm run dev:desktop",
        name: "desktop",
        env: { HMM_CHAT_NAME: name },
      },
    ],
    {
      killOthersOn: ["failure", "success"],
      prefix: "name",
      prefixColors: "auto",
    },
  );

  try {
    await result;
  } catch {
    process.exitCode = 1;
  }
}
