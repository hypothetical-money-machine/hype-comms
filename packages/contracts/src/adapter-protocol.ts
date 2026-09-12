import { z } from "zod";
import { agentContextPackSchema } from "./workspace.js";

/** The CLI's machine-output protocol is versioned separately from the workspace HTTP API. */
export const CLI_ADAPTER_PROTOCOL = 1;
export const cliAdapterEnvelopeSchema = z
  .object({
    adapterProtocol: z.literal(CLI_ADAPTER_PROTOCOL),
    kind: z.enum(["result", "event"]),
    data: z.unknown(),
  })
  .strict();
export type CliAdapterEnvelope = z.infer<typeof cliAdapterEnvelopeSchema>;

export function cliAdapterEnvelope(
  kind: CliAdapterEnvelope["kind"],
  data: unknown,
): CliAdapterEnvelope {
  return { adapterProtocol: CLI_ADAPTER_PROTOCOL, kind, data };
}

/** Context metadata and already-delimited text consumed by the Hermes adapter. */
export const cliAdapterContextSchema = z
  .object({
    contextPack: agentContextPackSchema,
    renderedContext: z.string().min(1).max(1_048_576),
  })
  .strict();
export type CliAdapterContext = z.infer<typeof cliAdapterContextSchema>;
