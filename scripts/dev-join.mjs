import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { developmentNameUsage, parseDevelopmentName } from "./development-name.mjs";

const name = parseDevelopmentName(process.argv.slice(2));
if (name === null) {
  process.stderr.write(
    `A valid temporary chat identity is required.\nUsage: npm run dev:join -- ${developmentNameUsage}\n`,
  );
  process.exitCode = 1;
} else {
  const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  const electronPath = require("electron");
  if (typeof electronPath !== "string") {
    throw new TypeError("Electron executable path is unavailable");
  }

  const child = spawn(electronPath, ["apps/desktop", `--name=${name}`], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: "http://127.0.0.1:5173",
      HMM_CHAT_NAME: name,
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
