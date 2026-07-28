import assert from "node:assert/strict";
import test from "node:test";

import { EXPECTED_VITE_VERSION, validateViteStackLockfile } from "./verify-vite-stack.mjs";

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
    /Expected one Vite 8\.1\.5 installation.*7\.3\.6/u,
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
