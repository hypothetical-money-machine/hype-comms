export const developmentProfileUsage = "[--profile=<slug>]";

export function parseDevelopmentProfile(arguments_) {
  let profile = "";
  for (const argument of arguments_) {
    if (!argument.startsWith("--profile=") || profile !== "") return null;
    profile = argument.slice("--profile=".length);
  }
  return profile === "" || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile) ? profile : null;
}
