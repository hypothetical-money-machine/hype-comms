import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveAgentWakePackageEvidence,
  resolveAgentWakeRollout,
} from "../apps/desktop/agent-wake-rollout.mjs";

test("agent wake rollout is default-off and accepts an explicit disabled value", () => {
  assert.equal(resolveAgentWakeRollout(undefined), false);
  assert.equal(resolveAgentWakeRollout(""), false);
  assert.equal(resolveAgentWakeRollout(" 0 "), false);
});

test("agent wake rollout enables only the explicit pilot value", () => {
  assert.equal(resolveAgentWakeRollout("1"), true);
  assert.throws(
    () => resolveAgentWakeRollout("true"),
    /HYPE_COMMS_AGENT_WAKE_ENABLED must be 0 or 1/,
  );
});

test("package evidence is compiled out unless explicitly enabled", () => {
  assert.equal(resolveAgentWakePackageEvidence(undefined, true), false);
  assert.equal(resolveAgentWakePackageEvidence("0", true), false);
});

test("package evidence requires agent wake and rejects ambiguous values", () => {
  assert.equal(resolveAgentWakePackageEvidence("1", true), true);
  assert.throws(
    () => resolveAgentWakePackageEvidence("1", false),
    /requires HYPE_COMMS_AGENT_WAKE_ENABLED=1/,
  );
  assert.throws(
    () => resolveAgentWakePackageEvidence("true", true),
    /HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED must be 0 or 1/,
  );
});
