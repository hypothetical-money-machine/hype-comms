import concurrently from "concurrently";

import { developmentProfileUsage, parseDevelopmentProfile } from "./development-profile.mjs";

function fail(message) {
  process.stderr.write(`${message}\nUsage: npm run dev -- ${developmentProfileUsage}\n`);
  process.exitCode = 1;
}

const profile = parseDevelopmentProfile(process.argv.slice(2));
if (profile === null) {
  fail("The development profile must be a lowercase slug.");
} else {
  const { result } = concurrently(
    [
      { command: "npm run dev:server", name: "server" },
      {
        command: "npm run dev:desktop",
        name: "desktop",
        env: profile === "" ? {} : { HYPE_COMMS_DESKTOP_PROFILE: profile },
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
