export const developmentNameUsage = "--name <display-name>";

export function parseDevelopmentName(args) {
  let name;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--name") {
      if (name !== undefined || index + 1 >= args.length) return null;
      name = args[index + 1];
      index += 1;
      continue;
    }
    if (argument?.startsWith("--name=")) {
      if (name !== undefined) return null;
      name = argument.slice("--name=".length);
      continue;
    }
    return null;
  }

  const normalized = name?.trim();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    normalized.length > 80 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}
