import { z } from "zod";

/**
 * Result of the desktop main process probing whether the auth URL scheme (for example
 * `hype-comms://`) is bound to this application on the host. `unknown` covers platforms and hosts
 * where the probe cannot run (non-Linux, unpackaged, missing xdg-utils); only `unbound` indicates a
 * confirmed missing or foreign handler.
 */
export const protocolHandlerStateSchema = z
  .object({
    scheme: z.string().min(1).max(64),
    binding: z.enum(["bound", "unbound", "unknown"]),
  })
  .strict();

export type ProtocolHandlerState = z.infer<typeof protocolHandlerStateSchema>;
