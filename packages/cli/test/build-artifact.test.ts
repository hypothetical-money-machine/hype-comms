import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import {
  SELF_CONTAINED_NODE_REQUIRE_BANNER,
  assertSelfContainedNodeBundle,
} from "../build-invariants.mjs";

const bundlePath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const executeFile = promisify(execFile);
const nodeBuiltinModules = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

describe("CLI build artifact", () => {
  it("is self-contained apart from the pinned Node runtime", async () => {
    const result = await build({
      entryPoints: [bundlePath],
      bundle: false,
      metafile: true,
      platform: "node",
      write: false,
    });
    const output = Object.values(result.metafile.outputs)[0];

    expect(output).toBeDefined();
    expect(output?.imports.some(({ path }) => !path.startsWith("node:"))).toBe(false);
    const bundle = await readFile(bundlePath, "utf8");
    expect(() => assertSelfContainedNodeBundle(bundle, nodeBuiltinModules)).not.toThrow();
    expect(bundle).not.toMatch(/(?:from|require\()\s*["'](?:ws|zod)["']/u);
  });

  it("rejects computed and non-builtin CommonJS loads", () => {
    const bundle = (body: string): string =>
      `#!/usr/bin/env node\n${SELF_CONTAINED_NODE_REQUIRE_BANNER}\n${body}`;
    expect(() =>
      assertSelfContainedNodeBundle(
        bundle("const value = __require(process.env.RUNTIME_MODULE);"),
        nodeBuiltinModules,
      ),
    ).toThrow("computed or non-builtin CommonJS module load");
    expect(() =>
      assertSelfContainedNodeBundle(
        bundle('const value = __require("node:not-a-real-builtin");'),
        nodeBuiltinModules,
      ),
    ).toThrow("computed or non-builtin CommonJS module load");
  });

  it("rejects module-loader capabilities outside the exact guard", () => {
    const prefix = `#!/usr/bin/env node\n${SELF_CONTAINED_NODE_REQUIRE_BANNER}\n`;
    expect(() =>
      assertSelfContainedNodeBundle(
        `${prefix}const value = __createRequire(import.meta.url)(process.env.RUNTIME_MODULE);`,
        nodeBuiltinModules,
      ),
    ).toThrow("additional native module-loader capability");
    expect(() =>
      assertSelfContainedNodeBundle(
        `${prefix}import { createRequire as loader } from "node:module"; loader(import.meta.url)(process.env.RUNTIME_MODULE);`,
        nodeBuiltinModules,
      ),
    ).toThrow("additional native module-loader capability");
  });

  it("runs directly under the explicitly selected Node runtime", async () => {
    const result = await executeFile(process.execPath, [bundlePath, "--help"], {
      env: { LANG: "C", NO_COLOR: "1" },
      maxBuffer: 64 * 1_024,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("hype-comms-cli - Hype Comms command-line client");
  });
});
