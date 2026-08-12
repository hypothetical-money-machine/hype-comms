import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseMacosNativeNotificationCaptureArguments } from "./capture-macos-native-notification.mjs";

test("constrains macOS native notification evidence to explicit absolute paths", () => {
  assert.deepEqual(
    parseMacosNativeNotificationCaptureArguments(
      ["--app=/tmp/Hype Comms.app", "--artifacts=/tmp/native-evidence"],
      {},
    ),
    {
      appBundle: path.resolve("/tmp/Hype Comms.app"),
      artifactDirectory: path.resolve("/tmp/native-evidence"),
    },
  );
  assert.throws(
    () =>
      parseMacosNativeNotificationCaptureArguments(
        ["--app=relative.app", "--artifacts=/tmp/native-evidence"],
        {},
      ),
    /--app must be an absolute/u,
  );
  assert.throws(
    () =>
      parseMacosNativeNotificationCaptureArguments(
        ["--app=/tmp/Hype Comms.app", "--artifacts=relative"],
        {},
      ),
    /--artifacts must be a non-root absolute/u,
  );
});
