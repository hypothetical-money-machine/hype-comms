import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { developmentProfileUsage, parseDevelopmentProfile } from "./development-profile.mjs";

const profile = parseDevelopmentProfile(process.argv.slice(2));
if (profile === null || profile === "") {
  process.stderr.write(
    `A non-empty development profile is required.\n` +
      `Usage: npm run dev:join -- ${developmentProfileUsage}\n`,
  );
  process.exitCode = 1;
} else {
  const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  const electronPath = require("electron");
  if (typeof electronPath !== "string") {
    throw new TypeError("Electron executable path is unavailable");
  }

  const child = spawn(electronPath, ["apps/desktop"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: "http://127.0.0.1:5173",
      HMM_DESKTOP_PROFILE: profile,
    },
    stdio: "inherit",
  });

  child.once("error", (error) => {
    process.stderr.write(`Could not start the additional desktop client: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (code !== null) {
      process.exitCode = code;
    } else if (signal !== null) {
      process.kill(process.pid, signal);
    }
  });
}
