import { z } from "zod";
import { agentContextPackSchema, utf8ByteLength } from "./workspace.js";

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

/**
 * Upper bound on the rendered context pack, counted in UTF-8 bytes.
 *
 * The Hermes adapter mirrors this number as MAX_RENDERED_CONTEXT_PACK_BYTES and checks it against
 * the encoded transport bytes, so this schema counts bytes rather than UTF-16 code units. A string
 * of astral or three-byte characters is far shorter in code units than on the wire, and the two
 * sides have to agree on which one the limit means.
 */
export const MAX_RENDERED_CONTEXT_BYTES = 1_048_576;

/** Context metadata and already-delimited text consumed by the Hermes adapter. */
export const cliAdapterContextSchema = z
  .object({
    contextPack: agentContextPackSchema,
    renderedContext: z
      .string()
      .min(1)
      // A UTF-16 length never exceeds the UTF-8 byte length, so this is a cheap constant-time
      // pre-check; the refine below applies the byte bound the adapter enforces.
      .max(MAX_RENDERED_CONTEXT_BYTES)
      .refine((value) => utf8ByteLength(value) <= MAX_RENDERED_CONTEXT_BYTES, {
        message: `renderedContext must be at most ${MAX_RENDERED_CONTEXT_BYTES} UTF-8 bytes`,
      }),
  })
  .strict();
export type CliAdapterContext = z.infer<typeof cliAdapterContextSchema>;
