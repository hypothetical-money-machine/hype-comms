import WebSocket from "ws";
import { WorkspaceRealtimeClient, type WorkspaceRealtimeScope } from "@hype-comms/api-client";
import { reportMainProcessError } from "./main-process-log";
export {
  WORKSPACE_REALTIME_MAX_PAYLOAD_BYTES,
  WORKSPACE_REALTIME_PENDING_REPLAY_BYTE_LIMIT,
  WORKSPACE_REALTIME_PENDING_REPLAY_EVENT_LIMIT,
  TYPING_SEND_INTERVAL_MS,
  TYPING_LOCAL_TTL_MS,
  createRealtimeEpochAllocator,
  type RealtimeConnectionState,
  type RealtimeDropReason,
  type RealtimeSession,
  type WorkspaceRealtimeScope,
} from "@hype-comms/api-client";

type Options = ConstructorParameters<typeof WorkspaceRealtimeClient>[0];
/** Supplies Electron's origin and socket implementation to the shared protocol client. */
export class WorkspaceRealtime extends WorkspaceRealtimeClient {
  constructor(
    options: Omit<Options, "clientOrigin" | "createSocket"> & {
      readonly rendererOrigin: string;
      readonly createSocket?: Options["createSocket"];
    },
  ) {
    super({
      ...options,
      clientOrigin: options.rendererOrigin,
      createSocket: options.createSocket ?? ((url, init) => new WebSocket(url, init)),
      reportError: options.reportError ?? reportMainProcessError,
    });
  }
  rendererUnavailable(): void {
    this.consumerUnavailable();
  }
  enterWindowless(scope: WorkspaceRealtimeScope): void {
    this.observeOnly(scope);
  }
}
