import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(packageDirectory, "dist");

await rm(outputDirectory, { recursive: true, force: true });

const result = await build({
  absWorkingDir: packageDirectory,
  entryPoints: {
    bin: "src/bin.ts",
    "private-download-worker": "src/private-download-worker.ts",
  },
  outdir: "dist",
  bundle: true,
  external: ["ws", "zod"],
  format: "esm",
  legalComments: "none",
  metafile: true,
  platform: "node",
  sourcemap: true,
  target: "node24",
});

const expectedOutputs = ["dist/bin.js", "dist/private-download-worker.js"];
for (const expectedOutput of expectedOutputs) {
  if (result.metafile.outputs[expectedOutput] === undefined) {
    throw new Error(`The CLI bundle was not produced: ${expectedOutput}`);
  }
}

const unexpectedRuntimeImports = expectedOutputs
  .flatMap((output) => result.metafile.outputs[output]?.imports ?? [])
  .map(({ path }) => path)
  .filter((path) => path !== "ws" && path !== "zod" && !path.startsWith("node:"));
if (unexpectedRuntimeImports.length > 0) {
  throw new Error(
    `The CLI bundle contains unexpected runtime imports: ${unexpectedRuntimeImports.join(", ")}`,
  );
}
