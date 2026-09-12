import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const repository = fileURLToPath(new URL("../", import.meta.url));
const root = path.join(repository, ".dev-data/rehearsal");
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, "claude-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "hype-claude-rehearsal-"));
const resultFile = path.join(root, "claude.json");
await rm(resultFile, { force: true });
try {
  const entry = path.join(directory, "main.cjs");
  await build({
    entryPoints: [path.join(repository, "scripts/rehearsal/claude-main.ts")],
    outfile: entry,
    bundle: true,
    platform: "node",
    packages: "external",
    format: "cjs",
  });
  const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  await promisify(execFile)(
    require("electron"),
    [...(process.env.HYPE_COMMS_REHEARSAL_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), entry],
    {
      env: {
        ...process.env,
        HYPE_COMMS_REHEARSAL_DIRECTORY: workspace,
        HYPE_COMMS_REHEARSAL_CLAUDE_WORKER: path.join(
          repository,
          "apps/desktop/dist/main/claude-acp-worker.js",
        ),
      },
      timeout: 100_000,
      maxBuffer: 64 * 1_024,
    },
  );
  await writeFile(resultFile, await readFile(path.join(workspace, "result.json")));
  console.log("Real Claude session, synthetic reply, close and worker shutdown passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}
