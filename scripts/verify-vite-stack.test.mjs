import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_VITE_VERSION,
  EXPECTED_ZOD_VERSION,
  validateViteStackLockfile,
  validateZodStackLockfile,
} from "./verify-vite-stack.mjs";

function compatibleLockfile() {
  return {
    packages: {
      "node_modules/@vitejs/plugin-react": {
        peerDependencies: {
          vite: "^8.0.0",
        },
        version: "6.0.4",
      },
      "node_modules/electron-vite": {
        peerDependencies: {
          vite: "^6.0.0 || ^7.0.0 || ^8.0.0",
        },
        version: "6.0.0-beta.1",
      },
      "node_modules/vite": {
        version: EXPECTED_VITE_VERSION,
      },
      "node_modules/vitest": {
        peerDependencies: {
          vite: "^6.0.0 || ^7.0.0 || ^8.0.0",
        },
        version: "4.1.10",
      },
      "node_modules/zod": {
        version: EXPECTED_ZOD_VERSION,
      },
    },
  };
}

test("accepts one Vite version with compatible peer ranges", () => {
  assert.deepEqual(validateViteStackLockfile(compatibleLockfile()), {
    checkedPeerRanges: 3,
    vitePath: "node_modules/vite",
    viteVersion: EXPECTED_VITE_VERSION,
  });
});

test("rejects duplicate Vite installations", () => {
  const lockfile = compatibleLockfile();
  lockfile.packages["apps/desktop/node_modules/vite"] = {
    version: "7.3.6",
  };

  assert.throws(
    () => validateViteStackLockfile(lockfile),
    new RegExp(
      `Expected one Vite ${EXPECTED_VITE_VERSION.replaceAll(".", "\\.")} installation.*7\\.3\\.6`,
      "u",
    ),
  );
});

test("rejects a peer range incompatible with the selected Vite", () => {
  const lockfile = compatibleLockfile();
  lockfile.packages["node_modules/legacy-vite-plugin"] = {
    peerDependencies: {
      vite: "^7.0.0",
    },
    version: "1.0.0",
  };

  assert.throws(
    () => validateViteStackLockfile(lockfile),
    /legacy-vite-plugin declares vite \^7\.0\.0/u,
  );
});

test("accepts one zod version", () => {
  assert.deepEqual(validateZodStackLockfile(compatibleLockfile()), {
    zodPath: "node_modules/zod",
    zodVersion: EXPECTED_ZOD_VERSION,
  });
});

test("rejects duplicate zod installations", () => {
  const lockfile = compatibleLockfile();
  lockfile.packages["apps/desktop/node_modules/zod"] = {
    version: "3.25.0",
  };

  assert.throws(
    () => validateZodStackLockfile(lockfile),
    new RegExp(
      `Expected one zod ${EXPECTED_ZOD_VERSION.replaceAll(".", "\\.")} installation.*3\\.25\\.0`,
      "u",
    ),
  );
});
