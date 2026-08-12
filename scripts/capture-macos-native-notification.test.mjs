import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseMacosNativeNotificationCaptureArguments } from "./capture-macos-native-notification.mjs";

test("constrains macOS native notification evidence to explicit absolute paths", () => {
  assert.deepEqual(
    parseMacosNativeNotificationCaptureArguments(
      [
        "--app=/tmp/Hype Comms.app",
        "--helper=/tmp/Hype Comms Evidence.app",
        "--notification-helper=/tmp/Hype Comms Authorization.app",
        "--artifacts=/tmp/native-evidence",
      ],
      {},
    ),
    {
      appBundle: path.resolve("/tmp/Hype Comms.app"),
      helperBundle: path.resolve("/tmp/Hype Comms Evidence.app"),
      notificationHelperBundle: path.resolve("/tmp/Hype Comms Authorization.app"),
      artifactDirectory: path.resolve("/tmp/native-evidence"),
    },
  );
  assert.throws(
    () =>
      parseMacosNativeNotificationCaptureArguments(
        [
          "--app=relative.app",
          "--helper=/tmp/Hype Comms Evidence.app",
          "--notification-helper=/tmp/Hype Comms Authorization.app",
          "--artifacts=/tmp/native-evidence",
        ],
        {},
      ),
    /--app must be an absolute/u,
  );
  assert.throws(
    () =>
      parseMacosNativeNotificationCaptureArguments(
        [
          "--app=/tmp/Hype Comms.app",
          "--helper=/tmp/Hype Comms Evidence.app",
          "--notification-helper=/tmp/Hype Comms Authorization.app",
          "--artifacts=relative",
        ],
        {},
      ),
    /--artifacts must be a non-root absolute/u,
  );
  assert.throws(
    () =>
      parseMacosNativeNotificationCaptureArguments(
        [
          "--app=/tmp/Hype Comms.app",
          "--helper=relative.app",
          "--notification-helper=/tmp/Hype Comms Authorization.app",
          "--artifacts=/tmp/native-evidence",
        ],
        {},
      ),
    /--helper must be an absolute/u,
  );
  assert.throws(
    () =>
      parseMacosNativeNotificationCaptureArguments(
        [
          "--app=/tmp/Hype Comms.app",
          "--helper=/tmp/Hype Comms Evidence.app",
          "--notification-helper=relative.app",
          "--artifacts=/tmp/native-evidence",
        ],
        {},
      ),
    /--notification-helper must be an absolute/u,
  );
  assert.throws(
    () =>
      parseMacosNativeNotificationCaptureArguments(
        [
          "--app=/tmp/Hype Comms.app",
          "--helper=/tmp/shared-helper.app",
          "--notification-helper=/tmp/shared-helper.app",
          "--artifacts=/tmp/native-evidence",
        ],
        {},
      ),
    /must identify different app bundles/u,
  );
});
