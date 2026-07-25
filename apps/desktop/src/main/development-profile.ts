const PROFILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function resolveDevelopmentProfile(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = env.HMM_DESKTOP_PROFILE?.trim() ?? "";
  if (value === "") return "";
  if (!PROFILE_PATTERN.test(value)) {
    throw new Error("HMM_DESKTOP_PROFILE must be a lowercase slug");
  }
  return value;
}
