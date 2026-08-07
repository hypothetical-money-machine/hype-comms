import { ApiClient } from "./client.js";
import { resolveProfile } from "./config.js";
import type { CommandContext } from "./types.js";

export async function clientFromContext(context: CommandContext): Promise<ApiClient> {
  const profile = await resolveProfile(context.runtime, context.options);
  return new ApiClient({
    profile,
    fetch: context.runtime.fetch,
    timeoutMs: context.options.timeoutMs,
  });
}
