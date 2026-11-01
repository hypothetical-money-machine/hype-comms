export const SELF_CONTAINED_NODE_REQUIRE_BANNER =
  'import { builtinModules as __builtinModules, createRequire as __createRequire } from "node:module"; const require = (() => { const allowed = new Set(__builtinModules.map((name) => name.replace(/^node:/u, ""))); const nativeRequire = __createRequire(import.meta.url); return (specifier) => { if (typeof specifier !== "string" || !specifier.startsWith("node:") || !allowed.has(specifier.slice(5))) throw new Error("The CLI bundle attempted an unpinned module load"); return nativeRequire(specifier); }; })();';

/**
 * Rejects any runtime module lookup that is not a literal canonical Node built-in. This is a
 * deliberately strict check over esbuild output: a false positive stops the release build instead
 * of silently making the pinned CLI entrypoint depend on an unpinned neighboring file.
 */
export function assertSelfContainedNodeBundle(bundle, builtinModuleNames) {
  const guardedPrefix = `#!/usr/bin/env node\n${SELF_CONTAINED_NODE_REQUIRE_BANNER}\n`;
  if (!bundle.startsWith(guardedPrefix)) {
    throw new Error("The CLI bundle is missing its exact runtime module guard");
  }
  const guardedBody = bundle.slice(guardedPrefix.length);
  if (
    /\b(?:createRequire|__createRequire|__nativeRequire)\b/u.test(guardedBody) ||
    /["']node:module["']/u.test(guardedBody)
  ) {
    throw new Error("The CLI bundle contains an additional native module-loader capability");
  }

  const helperCalls = [...guardedBody.matchAll(/\b__require\s*\(/gu)];
  const literalBuiltinCalls = [
    ...guardedBody.matchAll(/\b__require\s*\(\s*["']node:([^"']+)["']\s*\)/gu),
  ];
  if (
    helperCalls.length !== literalBuiltinCalls.length ||
    literalBuiltinCalls.some((match) => {
      const specifier = match[1];
      return specifier === undefined || !builtinModuleNames.has(specifier);
    })
  ) {
    throw new Error("The CLI bundle contains a computed or non-builtin CommonJS module load");
  }
  if (/(?<!_)\brequire\s*\(/u.test(guardedBody) || /\bimport\s*\(/u.test(guardedBody)) {
    throw new Error("The CLI bundle contains an unverified runtime module load");
  }
}
