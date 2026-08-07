import { healthResponseSchema, readinessResponseSchema } from "@hmm-chat/contracts";

import { clientFromContext } from "../context.js";
import { writeResult } from "../output.js";
import type { CommandContext } from "../types.js";

export async function health(context: CommandContext): Promise<void> {
  const value = await (
    await clientFromContext(context)
  ).request({
    path: "/livez",
    responseSchema: healthResponseSchema,
    includeCredential: false,
  });
  writeResult(context.runtime.io, value, context.options.json);
}

export async function readiness(context: CommandContext): Promise<void> {
  const value = await (
    await clientFromContext(context)
  ).request({
    path: "/readyz",
    responseSchema: readinessResponseSchema,
    acceptedStatuses: [200, 503],
    includeCredential: false,
  });
  writeResult(context.runtime.io, value, context.options.json);
}
