/** Build-time rollout switch. Packaged and development builds fail closed unless explicitly on. */
export function resolveNativeNotificationRollout(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  if (normalized === "" || normalized === "0") return false;
  if (normalized === "1") return true;
  throw new Error("HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED must be 0 or 1");
}

/** Build-time rollout switch for the privileged agent wake broker. */
export function resolveAgentWakeRollout(value: string | undefined): boolean {
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
export function resolveAgentWakePackageEvidence(
  value: string | undefined,
  agentWakeEnabled: boolean,
): boolean {
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

/** Compile a synthetic native-evidence harness only into an explicitly requested pilot artifact. */
export function resolveMacosNativeNotificationEvidence(
  value: string | undefined,
  nativeNotificationsEnabled: boolean,
): boolean {
  const normalized = value?.trim() ?? "";
  if (normalized === "" || normalized === "0") return false;
  if (normalized !== "1") {
    throw new Error("HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_ENABLED must be 0 or 1");
  }
  if (!nativeNotificationsEnabled) {
    throw new Error(
      "HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_ENABLED requires HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED=1",
    );
  }
  return true;
}
