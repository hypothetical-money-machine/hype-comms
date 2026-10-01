import assert from "node:assert/strict";
import test from "node:test";

import { validateZodAlignment } from "./verify-zod-alignment.mjs";

function fixture() {
  const manifests = {
    "packages/contracts": { dependencies: { zod: "4.4.3" } },
    "apps/desktop": { dependencies: { zod: "4.4.3" } },
    "packages/unrelated": { dependencies: {} },
  };
  const lockfile = {
    packages: {
      ...structuredClone(manifests),
      "node_modules/zod": { version: "4.4.3" },
      "node_modules/third-party/node_modules/zod": { version: "3.25.0" },
    },
  };
  return { manifests, lockfile };
}

test("accepts aligned consumers without policing unrelated transitive Zod versions", () => {
  const { manifests, lockfile } = fixture();
  assert.deepEqual(validateZodAlignment(manifests, lockfile), {
    version: "4.4.3",
    consumers: ["packages/contracts", "apps/desktop"],
  });
});

test("rejects a different pin, range or peer dependency", () => {
  for (const declaration of [
    { dependencies: { zod: "4.4.2" } },
    { dependencies: { zod: "^4.4.3" } },
    { peerDependencies: { zod: "4.4.3" } },
  ]) {
    const { manifests, lockfile } = fixture();
    manifests["apps/desktop"] = declaration;
    assert.throws(() => validateZodAlignment(manifests, lockfile), /apps\/desktop must declare/u);
  }
});

test("rejects stale lock declarations and a nearer incompatible installation", () => {
  const { manifests, lockfile } = fixture();
  lockfile.packages["apps/desktop"].dependencies.zod = "4.4.2";
  assert.throws(() => validateZodAlignment(manifests, lockfile), /stale Zod declaration/u);
  lockfile.packages["apps/desktop"].dependencies.zod = "4.4.3";
  lockfile.packages["apps/node_modules/zod"] = { version: "4.4.2" };
  assert.throws(() => validateZodAlignment(manifests, lockfile), /resolves Zod 4\.4\.2/u);
});

test("rejects missing installed Zod and an unpinned contracts dependency", () => {
  const { manifests, lockfile } = fixture();
  delete lockfile.packages["node_modules/zod"];
  assert.throws(() => validateZodAlignment(manifests, lockfile), /resolves Zod undefined/u);
  manifests["packages/contracts"].dependencies.zod = "^4.4.3";
  assert.throws(() => validateZodAlignment(manifests, lockfile), /Contracts must declare/u);
});
