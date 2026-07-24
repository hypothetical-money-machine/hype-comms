import concurrently from "concurrently";

import { describeDevelopmentAccess, DEVELOPMENT_SERVER_ENV } from "./development-chat.mjs";
import { developmentNameUsage, parseDevelopmentName } from "./development-name.mjs";

function fail(message) {
  process.stderr.write(`${message}\nUsage: npm run dev -- ${developmentNameUsage}\n`);
  process.exitCode = 1;
}

const name = parseDevelopmentName(process.argv.slice(2));
if (name === null) {
  fail("A valid temporary chat identity is required.");
} else {
  process.stdout.write(`${describeDevelopmentAccess()}\n`);
  const { result } = concurrently(
    [
      { command: "npm run dev:server", name: "server", env: { ...DEVELOPMENT_SERVER_ENV } },
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
