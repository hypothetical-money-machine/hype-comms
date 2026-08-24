/** Build-time rollout switch. Packaged and development builds fail closed unless explicitly on. */
export function resolveNativeNotificationRollout(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  if (normalized === "" || normalized === "0") return false;
  if (normalized === "1") return true;
  throw new Error("HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED must be 0 or 1");
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
