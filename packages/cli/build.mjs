import { readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import {
  SELF_CONTAINED_NODE_REQUIRE_BANNER,
  assertSelfContainedNodeBundle,
} from "./build-invariants.mjs";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(packageDirectory, "dist");
const nodeBuiltinModules = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

const canonicalNodeImports = {
  name: "canonical-node-imports",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const bareName = args.path.replace(/^node:/u, "");
      return nodeBuiltinModules.has(bareName)
        ? { external: true, path: `node:${bareName}` }
        : undefined;
    });
  },
};

await rm(outputDirectory, { recursive: true, force: true });

const result = await build({
  absWorkingDir: packageDirectory,
  entryPoints: ["src/bin.ts"],
  outfile: "dist/bin.js",
  banner: {
    // Bundled CommonJS dependencies call Node built-ins through esbuild's `__require` shim. Keep a
    // runtime allowlist in addition to the build assertion below, so even a future computed helper
    // call cannot resolve an unpinned module or absolute pathname.
    js: SELF_CONTAINED_NODE_REQUIRE_BANNER,
  },
  bundle: true,
  define: {
    // `ws` treats these native addons as optional accelerators. Pin the portable bundled path so
    // the wake CLI cannot load an unpinned module beside the otherwise self-contained entrypoint.
    "process.env.WS_NO_BUFFER_UTIL": '"1"',
    "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
  },
  format: "esm",
  legalComments: "none",
  metafile: true,
  platform: "node",
  plugins: [canonicalNodeImports],
  sourcemap: true,
  target: "node24",
});

const output = result.metafile.outputs["dist/bin.js"];
if (output === undefined) {
  throw new Error("The CLI bundle was not produced");
}

const unexpectedRuntimeImports = output.imports
  .map(({ path }) => path)
  .filter((path) => !path.startsWith("node:"));
if (unexpectedRuntimeImports.length > 0) {
  throw new Error(
    `The CLI bundle contains unexpected runtime imports: ${unexpectedRuntimeImports.join(", ")}`,
  );
}

const bundle = await readFile(resolve(outputDirectory, "bin.js"), "utf8");
assertSelfContainedNodeBundle(bundle, nodeBuiltinModules);
