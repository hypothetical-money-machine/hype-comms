import { randomUUID } from "node:crypto";

import { productRealtimeEventSchema, type ProductRealtimeEvent } from "@hmm-chat/contracts";
import WebSocket, { type RawData } from "ws";

import { reportMainProcessError } from "./main-process-log";
import type { WorkspaceTransport } from "./workspace-transport";

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const INVALID_EVENT_CLOSE_CODE = 1002;
const INVALID_EVENT_CLOSE_REASON = "Invalid realtime event";
const REPLAY_OVERFLOW_CLOSE_CODE = 1009;
const REPLAY_OVERFLOW_CLOSE_REASON = "Realtime replay buffer exceeded";

export const WORKSPACE_REALTIME_MAX_PAYLOAD_BYTES = 4 * 1_024 * 1_024;
export const WORKSPACE_REALTIME_PENDING_REPLAY_EVENT_LIMIT = 1_024;
export const WORKSPACE_REALTIME_PENDING_REPLAY_BYTE_LIMIT = 4 * 1_024 * 1_024;

export type RealtimeConnectionState = "connecting" | "live" | "offline" | "reconnecting";

export interface WorkspaceRealtimeScope {
  readonly userId: string;
  readonly workspaceId: string;
}

interface ActiveConnection {
  readonly epoch: number;
  readonly socket: WebSocket;
  readonly pendingReplay: ProductRealtimeEvent[];
  pendingReplayBytes: number;
  connectionId: string | null;
}

interface ReconnectTimer {
  readonly epoch: number;
  readonly handle: ReturnType<typeof setTimeout>;
}

interface PendingAuthoritativeRecovery {
  readonly scope: WorkspaceRealtimeScope;
  readonly cursor: string;
  readonly event: Extract<ProductRealtimeEvent, { type: "system.resync_required" }>;
}

type SocketFactory = (
  url: URL,
  options: { readonly origin: string; readonly maxPayload: number },
) => WebSocket;

/**
 * Owns one signed-in workspace's best-effort realtime transport.
 *
 * The cursor here is deliberately advanced only by `acknowledge()`. Receiving or validating an
 * event is not proof that the renderer durably applied it, so every failed connection resumes from
 * the last explicit acknowledgement. Epoch checks make ticket promises, socket callbacks, and
 * reconnect timers from a stopped or replaced session inert.
 */
export class WorkspaceRealtime {
  readonly #apiOrigin: string;
  readonly #rendererOrigin: string;
  readonly #transport: Pick<WorkspaceTransport, "ticket">;
  readonly #onEvent: (event: ProductRealtimeEvent) => boolean;
  readonly #onWindowlessEvent: (event: ProductRealtimeEvent) => void;
  readonly #onState: (state: RealtimeConnectionState) => void;
  readonly #createSocket: SocketFactory;
  #cursor = "0";
  #scope: WorkspaceRealtimeScope | null = null;
  #connection: ActiveConnection | null = null;
  #ticketEpoch: number | null = null;
  #timer: ReconnectTimer | null = null;
  #delayMs = INITIAL_RECONNECT_DELAY_MS;
  #epoch = 0;
  #stopped = true;
  #rendererDeliveryReady = false;
  #windowless = false;
  #pendingAuthoritativeRecovery: PendingAuthoritativeRecovery | null = null;

  constructor(options: {
    readonly apiOrigin: string;
    readonly rendererOrigin: string;
    readonly transport: Pick<WorkspaceTransport, "ticket">;
    /** Returns whether the event crossed into the currently subscribed renderer. */
    readonly onEvent: (event: ProductRealtimeEvent) => boolean;
    /** Observes an event without attempting renderer delivery or durable acknowledgement. */
    readonly onWindowlessEvent: (event: ProductRealtimeEvent) => void;
    readonly onState: (state: RealtimeConnectionState) => void;
    /** Test seam. Production always uses the `ws` implementation. */
    readonly createSocket?: SocketFactory;
  }) {
    this.#apiOrigin = options.apiOrigin;
    this.#rendererOrigin = options.rendererOrigin;
    this.#transport = options.transport;
    this.#onEvent = options.onEvent;
    this.#onWindowlessEvent = options.onWindowlessEvent;
    this.#onState = options.onState;
    this.#createSocket =
      options.createSocket ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
  }

  start(after: string, expectedScope: WorkspaceRealtimeScope): boolean {
    // The renderer invokes start only after installing its workspace-event subscriber and
    // completing HTTP catch-up. This is the explicit readiness handshake used to redeliver a
    // body-free recovery control that could not cross a crashed or reloading renderer boundary.
    const wasWindowless = this.#windowless;
    this.#windowless = false;
    this.#rendererDeliveryReady = true;
    const recovery = this.#pendingAuthoritativeRecovery;
    if (recovery !== null) {
      if (this.#sameScope(recovery.scope, expectedScope)) {
        if (BigInt(after) > BigInt(recovery.cursor)) {
          // A newer durable renderer cursor proves the authoritative HTTP recovery completed. Only
          // that explicit progress consumes the latch and permits a new socket; reconnecting from
          // the cursor that overflowed would deterministically overflow again.
          this.#pendingAuthoritativeRecovery = null;
          this.#beginEpoch(after, expectedScope);
          return true;
        }
        return this.#deliverPendingAuthoritativeRecovery();
      }
      // Starting another signed-in scope is a definitive replacement. Its renderer must never
      // receive a control event retained for the previous user or workspace.
      this.#pendingAuthoritativeRecovery = null;
    }

    if (!this.#stopped && this.#scope !== null && this.#sameScope(this.#scope, expectedScope)) {
      if (wasWindowless) {
        // Windowless delivery observes events for native attention only. It never advances the
        // renderer-owned cursor, so restart from the durable cursor supplied after HTTP catch-up.
        // Replaying a frame that raced that catch-up is safe and avoids an unobservable UI gap.
        this.#beginEpoch(after, expectedScope);
        return true;
      }
      this.acknowledge(after);
      return true;
    }

    this.#beginEpoch(after, expectedScope);
    return true;
  }

  /** Invalidates delivery readiness without treating a renderer reload as a signed-out scope. */
  rendererUnavailable(): void {
    this.#rendererDeliveryReady = false;
  }

  /**
   * Keeps the current signed-in transport alive solely as a notification observer.
   *
   * Events are intentionally neither buffered for a future renderer nor treated as durable UI
   * progress. A later renderer start must first complete HTTP catch-up and supplies the encrypted
   * replica cursor from which this transport opens a fresh epoch.
   */
  enterWindowless(expectedScope: WorkspaceRealtimeScope): void {
    this.#rendererDeliveryReady = false;
    this.#windowless = true;

    const recovery = this.#pendingAuthoritativeRecovery;
    if (recovery !== null) {
      if (this.#sameScope(recovery.scope, expectedScope)) return;
      this.#pendingAuthoritativeRecovery = null;
    }
    if (!this.#stopped && this.#scope !== null && this.#sameScope(this.#scope, expectedScope)) {
      return;
    }

    this.#beginEpoch(this.#cursor, expectedScope);
  }

  acknowledge(cursor: string): void {
    if (BigInt(cursor) > BigInt(this.#cursor)) this.#cursor = cursor;
  }

  stop(): void {
    this.#stopTransport(false);
  }

  /** Definitively retires the signed-in scope, including any retained recovery control. */
  resetSession(): void {
    this.#stopTransport(true);
  }

  #stopTransport(clearRecovery: boolean): void {
    this.#epoch += 1;
    this.#stopped = true;
    this.#scope = null;
    this.#rendererDeliveryReady = false;
    this.#windowless = false;
    if (clearRecovery) this.#pendingAuthoritativeRecovery = null;
    this.#ticketEpoch = null;
    this.#clearReconnectTimer();

    const connection = this.#connection;
    this.#connection = null;
    if (connection !== null) this.#closeSocket(connection.socket);

    this.#deliverState("offline");
  }

  #beginEpoch(after: string, expectedScope: WorkspaceRealtimeScope): void {
    this.#epoch += 1;
    const epoch = this.#epoch;
    this.#stopped = false;
    this.#cursor = after;
    this.#scope = { ...expectedScope };
    this.#ticketEpoch = null;
    this.#delayMs = INITIAL_RECONNECT_DELAY_MS;
    this.#clearReconnectTimer();

    const previousConnection = this.#connection;
    this.#connection = null;
    if (previousConnection !== null) this.#closeSocket(previousConnection.socket);

    this.#deliverState("connecting");
    void this.#connect(epoch);
  }

  async #connect(epoch: number): Promise<void> {
    if (!this.#isCurrentEpoch(epoch) || this.#connection !== null || this.#ticketEpoch !== null) {
      return;
    }

    this.#ticketEpoch = epoch;
    let ticket: Awaited<ReturnType<WorkspaceTransport["ticket"]>>;
    try {
      ticket = await this.#transport.ticket();
    } catch (error) {
      if (!this.#ownsTicketRequest(epoch)) return;
      this.#ticketEpoch = null;
      reportMainProcessError("Could not obtain a realtime ticket", error);
      this.#scheduleReconnect(epoch);
      return;
    }

    if (!this.#ownsTicketRequest(epoch)) return;
    this.#ticketEpoch = null;

    const url = new URL("/v1/realtime", this.#apiOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket.ticket);
    url.searchParams.set("after", this.#cursor);

    let socket: WebSocket;
    try {
      socket = this.#createSocket(url, {
        origin: this.#rendererOrigin,
        maxPayload: WORKSPACE_REALTIME_MAX_PAYLOAD_BYTES,
      });
    } catch (error) {
      if (!this.#isCurrentEpoch(epoch)) return;
      reportMainProcessError("Workspace realtime connection failed", error);
      this.#scheduleReconnect(epoch);
      return;
    }

    if (!this.#isCurrentEpoch(epoch) || this.#connection !== null) {
      this.#closeSocket(socket);
      return;
    }

    const connection: ActiveConnection = {
      epoch,
      socket,
      pendingReplay: [],
      pendingReplayBytes: 0,
      connectionId: null,
    };
    this.#connection = connection;

    socket.once("open", () => {
      if (!this.#isActiveConnection(connection)) return;
      this.#delayMs = INITIAL_RECONNECT_DELAY_MS;
    });
    socket.on("message", (data: RawData) => {
      this.#handleMessage(connection, data);
    });
    socket.on("error", (error) => {
      if (!this.#isActiveConnection(connection)) return;
      reportMainProcessError("Workspace realtime connection failed", error.message);
      this.#retireConnection(connection, true);
    });
    socket.once("close", () => {
      if (!this.#isActiveConnection(connection)) return;
      this.#connection = null;
      this.#scheduleReconnect(connection.epoch);
    });
  }

  #handleMessage(connection: ActiveConnection, data: RawData): void {
    if (!this.#isActiveConnection(connection)) return;

    const serialized = data.toString();
    const frameBytes = Buffer.byteLength(serialized);
    if (frameBytes > WORKSPACE_REALTIME_MAX_PAYLOAD_BYTES) {
      this.#rejectInvalidEvent(connection);
      return;
    }

    let input: unknown;
    try {
      input = JSON.parse(serialized);
    } catch {
      this.#rejectInvalidEvent(connection);
      return;
    }

    const parsed = productRealtimeEventSchema.safeParse(input);
    if (!parsed.success || !this.#matchesExpectedScope(parsed.data)) {
      this.#rejectInvalidEvent(connection);
      return;
    }

    const event = parsed.data;
    if (this.#windowless && event.type === "system.resync_required") {
      // A cursor-expired socket closes after this control. Observing it and reconnecting from the
      // same renderer-owned cursor would spin forever while no renderer exists to rebuild state.
      // Retain the validated body-free control and stop until renderer HTTP recovery proves a
      // strictly newer durable cursor.
      if (!this.#deliverEvent(connection, event)) return;
      this.#retainWindowlessAuthoritativeRecovery(connection, event);
      return;
    }
    if (event.type === "system.connected") {
      if (connection.connectionId !== null) {
        this.#rejectInvalidEvent(connection);
        return;
      }
      connection.connectionId = event.payload.connectionId;

      // Replay arrives before this handshake. Hold message-bearing frames until the server proves
      // that the ticket belongs to the expected user as well as the expected workspace; otherwise
      // a same-workspace sign-in replacement could briefly receive another user's event audience.
      for (const replayEvent of connection.pendingReplay) {
        if (!this.#deliverEvent(connection, replayEvent)) return;
        if (!this.#isActiveConnection(connection)) return;
      }
      connection.pendingReplay.length = 0;
      connection.pendingReplayBytes = 0;

      if (!this.#deliverState("live")) {
        this.#retireConnection(connection, true);
        return;
      }
      if (!this.#isActiveConnection(connection)) return;
    } else if (connection.connectionId === null && event.type !== "system.resync_required") {
      if (
        connection.pendingReplay.length >= WORKSPACE_REALTIME_PENDING_REPLAY_EVENT_LIMIT ||
        connection.pendingReplayBytes + frameBytes > WORKSPACE_REALTIME_PENDING_REPLAY_BYTE_LIMIT
      ) {
        this.#requireAuthoritativeRecovery(connection, event.occurredAt);
        return;
      }
      connection.pendingReplay.push(event);
      connection.pendingReplayBytes += frameBytes;
      return;
    }

    this.#deliverEvent(connection, event);
  }

  #deliverEvent(connection: ActiveConnection, event: ProductRealtimeEvent): boolean {
    if (this.#windowless) {
      try {
        this.#onWindowlessEvent(event);
      } catch {
        // Notification observation is outside transport health and durable acknowledgement. Keep
        // this diagnostic body-free and continue consuming the current authenticated connection.
        reportMainProcessError("Windowless workspace realtime observation failed");
      }
      return this.#isActiveConnection(connection);
    }

    try {
      if (!this.#rendererDeliveryReady || !this.#onEvent(event)) {
        // No durable renderer acknowledgement can follow a frame that did not cross the current
        // subscribed renderer boundary. Pause instead of reconnecting: the next explicit renderer
        // start follows HTTP catch-up and supplies the replica's durable cursor.
        reportMainProcessError("Workspace realtime event delivery is waiting for a ready renderer");
        this.#pauseForRenderer(connection);
        return false;
      }
      return true;
    } catch (error) {
      reportMainProcessError("Workspace realtime event delivery failed", error);
      this.#retireConnection(connection, true);
      return false;
    }
  }

  #matchesExpectedScope(event: ProductRealtimeEvent): boolean {
    const scope = this.#scope;
    if (scope === null || event.workspaceId !== scope.workspaceId) return false;
    return event.type !== "system.connected" || event.payload.userId === scope.userId;
  }

  #rejectInvalidEvent(connection: ActiveConnection): void {
    if (!this.#isActiveConnection(connection)) return;
    // Never include the rejected frame in logs: it can contain message or identity data.
    reportMainProcessError("Rejected an invalid realtime event");
    this.#retireConnection(connection, true, INVALID_EVENT_CLOSE_CODE, INVALID_EVENT_CLOSE_REASON);
  }

  #requireAuthoritativeRecovery(connection: ActiveConnection, occurredAt: string): void {
    if (!this.#isActiveConnection(connection) || this.#scope === null) return;
    const scope = this.#scope;
    const cursor = this.#cursor;

    // Drop message-bearing replay data before crossing the renderer boundary or logging. A new
    // socket from the same durable cursor would receive the same replay and overflow forever, so
    // this generation deliberately stops until the renderer finishes authoritative HTTP recovery
    // and explicitly starts again from its newly durable cursor.
    connection.pendingReplay.length = 0;
    connection.pendingReplayBytes = 0;
    reportMainProcessError("Workspace realtime replay exceeded its pre-live buffer");

    this.#epoch += 1;
    const recoveryEpoch = this.#epoch;
    this.#stopped = true;
    this.#scope = null;
    this.#ticketEpoch = null;
    this.#clearReconnectTimer();
    this.#connection = null;
    this.#closeSocket(connection.socket, REPLAY_OVERFLOW_CLOSE_CODE, REPLAY_OVERFLOW_CLOSE_REASON);

    const recoveryEvent: Extract<ProductRealtimeEvent, { type: "system.resync_required" }> = {
      version: 1,
      id: randomUUID(),
      type: "system.resync_required",
      occurredAt,
      workspaceId: scope.workspaceId,
      conversationId: null,
      workspaceSequence: cursor,
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { reason: "client_replay_overflow" },
    };
    this.#pendingAuthoritativeRecovery = {
      scope: { ...scope },
      cursor,
      event: recoveryEvent,
    };
    this.#deliverPendingAuthoritativeRecovery();

    if (this.#stopped && this.#epoch === recoveryEpoch) this.#deliverState("offline");
  }

  #retainWindowlessAuthoritativeRecovery(
    connection: ActiveConnection,
    event: Extract<ProductRealtimeEvent, { type: "system.resync_required" }>,
  ): void {
    if (!this.#isActiveConnection(connection) || this.#scope === null) return;
    const scope = this.#scope;
    const cursor = this.#cursor;

    connection.pendingReplay.length = 0;
    connection.pendingReplayBytes = 0;
    this.#epoch += 1;
    this.#stopped = true;
    this.#scope = null;
    this.#ticketEpoch = null;
    this.#clearReconnectTimer();
    this.#connection = null;
    this.#closeSocket(connection.socket);
    this.#pendingAuthoritativeRecovery = {
      scope: { ...scope },
      cursor,
      event,
    };
    this.#deliverState("offline");
  }

  #deliverPendingAuthoritativeRecovery(): boolean {
    const recovery = this.#pendingAuthoritativeRecovery;
    if (recovery === null) return true;
    if (!this.#rendererDeliveryReady) return false;
    try {
      if (!this.#onEvent(recovery.event)) {
        this.#rendererDeliveryReady = false;
        return false;
      }
    } catch {
      // Renderer failures can include arbitrary application data. Keep this diagnostic generic and
      // remain stopped; retrying the same replay would only repeat the overflow.
      this.#rendererDeliveryReady = false;
      reportMainProcessError("Workspace realtime recovery delivery failed");
      return false;
    }
    // Successful delivery is not recovery completion. Keep the body-free latch until a later start
    // supplies a strictly newer durable cursor, so a renderer crash during resync cannot reopen the
    // socket at the cursor that already overflowed.
    return true;
  }

  #pauseForRenderer(connection: ActiveConnection): void {
    if (!this.#isActiveConnection(connection)) return;
    this.#epoch += 1;
    this.#stopped = true;
    this.#scope = null;
    this.#rendererDeliveryReady = false;
    this.#windowless = false;
    this.#ticketEpoch = null;
    this.#clearReconnectTimer();
    this.#connection = null;
    this.#closeSocket(connection.socket);
    this.#deliverState("offline");
  }

  #retireConnection(
    connection: ActiveConnection,
    reconnect: boolean,
    closeCode?: number,
    closeReason?: string,
  ): void {
    if (!this.#isActiveConnection(connection)) return;
    this.#connection = null;
    this.#closeSocket(connection.socket, closeCode, closeReason);
    if (reconnect) this.#scheduleReconnect(connection.epoch);
  }

  #scheduleReconnect(epoch: number): void {
    if (!this.#isCurrentEpoch(epoch) || this.#timer !== null) return;
    this.#deliverState("reconnecting");
    // State delivery is application code and may synchronously stop or replace this generation.
    if (!this.#isCurrentEpoch(epoch) || this.#timer !== null) return;
    const maximum = this.#delayMs;
    const delay = Math.floor(Math.random() * maximum);
    this.#delayMs = Math.min(this.#delayMs * 2, MAX_RECONNECT_DELAY_MS);
    const handle = setTimeout(() => {
      if (this.#timer?.epoch === epoch && this.#timer.handle === handle) this.#timer = null;
      if (!this.#isCurrentEpoch(epoch)) return;
      void this.#connect(epoch);
    }, delay);
    this.#timer = { epoch, handle };
  }

  #deliverState(state: RealtimeConnectionState): boolean {
    try {
      this.#onState(state);
      return true;
    } catch (error) {
      reportMainProcessError("Workspace realtime state delivery failed", error);
      return false;
    }
  }

  #clearReconnectTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer.handle);
    this.#timer = null;
  }

  #closeSocket(socket: WebSocket, code?: number, reason?: string): void {
    try {
      socket.close(code, reason);
    } catch {
      try {
        socket.terminate();
      } catch {
        // A stale or already-closed socket is retired even if its implementation rejects cleanup.
      }
    }
  }

  #ownsTicketRequest(epoch: number): boolean {
    return this.#ticketEpoch === epoch && this.#isCurrentEpoch(epoch);
  }

  #isCurrentEpoch(epoch: number): boolean {
    return !this.#stopped && this.#epoch === epoch;
  }

  #isActiveConnection(connection: ActiveConnection): boolean {
    return this.#connection === connection && this.#isCurrentEpoch(connection.epoch);
  }

  #sameScope(left: WorkspaceRealtimeScope, right: WorkspaceRealtimeScope): boolean {
    return left.userId === right.userId && left.workspaceId === right.workspaceId;
  }
}
