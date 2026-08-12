/** Build-time rollout switch. Packaged and development builds fail closed unless explicitly on. */
export function resolveNativeNotificationRollout(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  if (normalized === "" || normalized === "0") return false;
  if (normalized === "1") return true;
  throw new Error("HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED must be 0 or 1");
}
