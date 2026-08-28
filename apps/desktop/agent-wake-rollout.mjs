/**
 * Build-time rollout switches for the privileged agent wake broker.
 *
 * These live beside `build-flavor.mjs` rather than in `src/` because the packaging verifier in
 * `scripts/` has to read the same switches the Vite build compiles in. A single authority keeps a
 * released artifact and the gate that checks it from ever disagreeing.
 */

/** Build-time rollout switch for the privileged agent wake broker. */
export function resolveAgentWakeRollout(value) {
  const normalized = value?.trim() ?? "";
  if (normalized === "" || normalized === "0") return false;
  if (normalized === "1") return true;
  throw new Error("HYPE_COMMS_AGENT_WAKE_ENABLED must be 0 or 1");
}

/**
 * Marks the signed Agent Wake pilot used for rollout evidence. The marker is separate from the
 * feature switch so ordinary production packages keep their updater, while the exact artifact
 * under a multi-hour soak cannot replace itself from the stable feed.
 */
export function resolveAgentWakePackageEvidence(value, agentWakeEnabled) {
  const normalized = value?.trim() ?? "";
  if (normalized === "" || normalized === "0") return false;
  if (normalized !== "1") {
    throw new Error("HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED must be 0 or 1");
  }
  if (!agentWakeEnabled) {
    throw new Error(
      "HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED requires HYPE_COMMS_AGENT_WAKE_ENABLED=1",
    );
  }
  return true;
}
