import type { AiChannelController } from "./ai-channel-controller";

/** Optional local-agent failure must not block clearing a rejected or explicitly ended login. */
export async function suspendLocalAi(
  controller: Pick<AiChannelController, "suspend"> | null,
  reportFailure: () => void,
): Promise<void> {
  try {
    await controller?.suspend();
  } catch {
    try {
      reportFailure();
    } catch {
      /* Diagnostics cannot prevent account replacement. */
    }
  }
}
