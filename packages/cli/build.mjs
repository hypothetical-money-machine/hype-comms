import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(packageDirectory, "dist");

await rm(outputDirectory, { recursive: true, force: true });

const result = await build({
  absWorkingDir: packageDirectory,
  entryPoints: ["src/bin.ts"],
  outfile: "dist/bin.js",
  bundle: true,
  external: ["ws", "zod"],
  format: "esm",
  legalComments: "none",
  metafile: true,
  platform: "node",
  sourcemap: true,
  target: "node24",
});

const output = result.metafile.outputs["dist/bin.js"];
if (output === undefined) {
  throw new Error("The CLI bundle was not produced");
}

const unexpectedRuntimeImports = output.imports
  .map(({ path }) => path)
  .filter((path) => path !== "ws" && path !== "zod" && !path.startsWith("node:"));
if (unexpectedRuntimeImports.length > 0) {
  throw new Error(
    `The CLI bundle contains unexpected runtime imports: ${unexpectedRuntimeImports.join(", ")}`,
  );
}
