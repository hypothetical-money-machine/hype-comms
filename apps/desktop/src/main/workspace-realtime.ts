import { randomUUID } from "node:crypto";

import {
  productRealtimeEventSchema,
  realtimeEventEnvelopeSchema,
  type ProductRealtimeEvent,
  type RealtimeAcknowledgement,
  type RealtimeConnectionState,
  type RealtimeSessionScope,
  type RealtimeTicketResponse,
  type ScopedProductRealtimeEvent,
} from "@hmm-chat/contracts";
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

export type { RealtimeConnectionState };

export type WorkspaceRealtimeScope = Pick<RealtimeSessionScope, "userId" | "workspaceId">;

export type RealtimeDropReason =
  | "invalid-envelope"
  | "late-ticket"
  | "renderer-delivery"
  | "stale-activation"
  | "stale-control"
  | "stale-socket"
  | "stale-timer"
  | "unsupported-event"
  | "wrong-user"
  | "wrong-workspace";

export interface RealtimeSession {
  readonly activeScope: RealtimeSessionScope | null;
  prepare(input: {
    readonly after: string;
    readonly userId: string;
    readonly workspaceId: string;
  }): RealtimeSessionScope;
  activate(scope: RealtimeSessionScope): boolean;
  acknowledge(input: RealtimeAcknowledgement): void;
  stop(scope?: RealtimeSessionScope): void;
}

interface ActiveConnection {
  readonly epoch: number;
  readonly scope: RealtimeSessionScope;
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
  readonly #onEvent: (frame: ScopedProductRealtimeEvent) => boolean;
  readonly #onWindowlessEvent: (event: ProductRealtimeEvent) => void;
  readonly #onState: (state: RealtimeConnectionState) => void;
  readonly #onDrop: (reason: RealtimeDropReason) => void;
  readonly #createSocket: SocketFactory;
  #cursor = "0";
  #scope: RealtimeSessionScope | null = null;
  #sessionEpoch = 0;
  #connection: ActiveConnection | null = null;
  #ticketEpoch: number | null = null;
  #timer: ReconnectTimer | null = null;
  #delayMs = INITIAL_RECONNECT_DELAY_MS;
  #epoch = 0;
  #stopped = true;
  #rendererDeliveryReady = false;
  #windowless = false;
  #incompatible = false;
  #pendingAuthoritativeRecovery: PendingAuthoritativeRecovery | null = null;

  constructor(options: {
    readonly apiOrigin: string;
    readonly rendererOrigin: string;
    readonly transport: Pick<WorkspaceTransport, "ticket">;
    /** Returns whether the event crossed into the currently subscribed renderer. */
    readonly onEvent: (frame: ScopedProductRealtimeEvent) => boolean;
    /** Observes an event without attempting renderer delivery or durable acknowledgement. */
    readonly onWindowlessEvent?: (event: ProductRealtimeEvent) => void;
    readonly onState: (state: RealtimeConnectionState) => void;
    readonly onDrop?: (reason: RealtimeDropReason) => void;
    /** Test seam. Production always uses the `ws` implementation. */
    readonly createSocket?: SocketFactory;
  }) {
    this.#apiOrigin = options.apiOrigin;
    this.#rendererOrigin = options.rendererOrigin;
    this.#transport = options.transport;
    this.#onEvent = options.onEvent;
    this.#onWindowlessEvent = options.onWindowlessEvent ?? (() => undefined);
    this.#onState = options.onState;
    this.#onDrop =
      options.onDrop ??
      ((reason) => reportMainProcessError(`Dropped a realtime artifact (${reason})`));
    this.#createSocket =
      options.createSocket ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
  }

  get activeScope(): RealtimeSessionScope | null {
    return this.#scope;
  }

  prepare(input: {
    readonly after: string;
    readonly userId: string;
    readonly workspaceId: string;
  }): RealtimeSessionScope {
    const recovery = this.#pendingAuthoritativeRecovery;
    const preserveRecovery =
      recovery !== null &&
      recovery.scope.userId === input.userId &&
      recovery.scope.workspaceId === input.workspaceId &&
      BigInt(input.after) <= BigInt(recovery.cursor);
    this.#retireTransport(!preserveRecovery, false);
    if (this.#sessionEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Realtime session epoch is exhausted");
    }
    const scope = Object.freeze({
      userId: input.userId,
      workspaceId: input.workspaceId,
      epoch: ++this.#sessionEpoch,
    });
    this.#scope = scope;
    this.#cursor = input.after;
    this.#stopped = true;
    this.#windowless = false;
    this.#rendererDeliveryReady = false;
    this.#incompatible = false;
    return scope;
  }

  activate(candidate: RealtimeSessionScope): boolean {
    const scope = this.#scope;
    if (scope === null || !sameRealtimeScope(scope, candidate)) {
      this.#onDrop("stale-activation");
      return false;
    }
    if (!this.#stopped) return true;
    this.#windowless = false;
    this.#rendererDeliveryReady = true;
    if (this.#pendingAuthoritativeRecovery !== null) {
      return this.#deliverPendingAuthoritativeRecovery();
    }
    this.#beginEpoch(this.#cursor, scope);
    return true;
  }

  /** Compatibility entrypoint for the pre-epoch window lifecycle. */
  start(after: string, expectedScope: WorkspaceRealtimeScope): boolean {
    const current = this.#scope;
    const recovery = this.#pendingAuthoritativeRecovery;
    if (recovery !== null && this.#sameScope(recovery.scope, expectedScope)) {
      if (BigInt(after) > BigInt(recovery.cursor)) {
        this.#pendingAuthoritativeRecovery = null;
      } else {
        const scope =
          current ??
          this.prepare({
            after,
            userId: expectedScope.userId,
            workspaceId: expectedScope.workspaceId,
          });
        this.#rendererDeliveryReady = true;
        this.#windowless = false;
        return this.activate(scope);
      }
    }

    if (current !== null && this.#sameScope(current, expectedScope) && !this.#stopped) {
      if (this.#windowless) {
        this.#rendererDeliveryReady = true;
        this.#windowless = false;
        this.#beginEpoch(after, current);
      } else {
        this.acknowledge(after);
      }
      return true;
    }

    const scope = this.prepare({
      after,
      userId: expectedScope.userId,
      workspaceId: expectedScope.workspaceId,
    });
    return this.activate(scope);
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

    const scope =
      this.#scope ??
      this.prepare({
        after: this.#cursor,
        userId: expectedScope.userId,
        workspaceId: expectedScope.workspaceId,
      });
    this.#beginEpoch(this.#cursor, scope);
  }

  acknowledge(input: RealtimeAcknowledgement | string): void {
    if (typeof input !== "string") {
      if (this.#scope === null || !sameRealtimeScope(this.#scope, input.scope)) {
        this.#onDrop("stale-control");
        return;
      }
      input = input.cursor;
    }
    if (BigInt(input) > BigInt(this.#cursor)) this.#cursor = input;
  }

  stop(candidate?: RealtimeSessionScope): void {
    if (
      candidate !== undefined &&
      (this.#scope === null || !sameRealtimeScope(this.#scope, candidate))
    ) {
      this.#onDrop("stale-control");
      return;
    }
    this.#stopTransport(false);
  }

  /** Definitively retires the signed-in scope, including any retained recovery control. */
  resetSession(): void {
    this.#stopTransport(true);
  }

  #stopTransport(clearRecovery: boolean): void {
    this.#retireTransport(clearRecovery, true);
  }

  #retireTransport(clearRecovery: boolean, announceOffline: boolean): void {
    this.#epoch += 1;
    this.#stopped = true;
    this.#incompatible = false;
    this.#scope = null;
    this.#rendererDeliveryReady = false;
    this.#windowless = false;
    if (clearRecovery) this.#pendingAuthoritativeRecovery = null;
    this.#ticketEpoch = null;
    this.#clearReconnectTimer();

    const connection = this.#connection;
    this.#connection = null;
    if (connection !== null) this.#closeSocket(connection.socket);

    if (announceOffline) this.#deliverState("offline");
  }

  #beginEpoch(after: string, expectedScope: RealtimeSessionScope): void {
    this.#epoch += 1;
    const epoch = this.#epoch;
    this.#stopped = false;
    this.#incompatible = false;
    this.#cursor = after;
    this.#scope = expectedScope;
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
    let ticket: RealtimeTicketResponse;
    try {
      ticket = await this.#transport.ticket();
    } catch (error) {
      if (!this.#ownsTicketRequest(epoch)) {
        this.#onDrop("late-ticket");
        return;
      }
      this.#ticketEpoch = null;
      reportMainProcessError("Could not obtain a realtime ticket", error);
      this.#scheduleReconnect(epoch);
      return;
    }

    if (!this.#ownsTicketRequest(epoch)) {
      this.#onDrop("late-ticket");
      return;
    }
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

    const scope = this.#scope;
    if (!this.#isCurrentEpoch(epoch) || scope === null || this.#connection !== null) {
      this.#onDrop("stale-socket");
      this.#closeSocket(socket);
      return;
    }

    const connection: ActiveConnection = {
      epoch,
      scope,
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
    if (!this.#isActiveConnection(connection)) {
      this.#onDrop("stale-socket");
      return;
    }

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

    const envelope = realtimeEventEnvelopeSchema.safeParse(input);
    if (!envelope.success) {
      this.#rejectInvalidEvent(connection);
      return;
    }
    if (envelope.data.workspaceId !== connection.scope.workspaceId) {
      this.#failIncompatible(connection, "wrong-workspace");
      return;
    }
    const parsed = productRealtimeEventSchema.safeParse(input);
    if (!parsed.success) {
      // A structurally valid event from a newer server is optional to this client. It remains in
      // the durable stream for a future version, but does not make this socket unusable.
      this.#onDrop("unsupported-event");
      return;
    }
    if (
      parsed.data.type === "system.connected" &&
      parsed.data.payload.userId !== connection.scope.userId
    ) {
      this.#failIncompatible(connection, "wrong-user");
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
      if (
        !this.#rendererDeliveryReady ||
        !this.#onEvent({ scope: connection.scope, event })
      ) {
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

  #rejectInvalidEvent(connection: ActiveConnection): void {
    if (!this.#isActiveConnection(connection)) return;
    // Never include the rejected frame in logs: it can contain message or identity data.
    this.#onDrop("invalid-envelope");
    reportMainProcessError("Rejected an invalid realtime event");
    this.#retireConnection(connection, true, INVALID_EVENT_CLOSE_CODE, INVALID_EVENT_CLOSE_REASON);
  }

  #failIncompatible(
    connection: ActiveConnection,
    reason: Extract<RealtimeDropReason, "wrong-user" | "wrong-workspace" | "invalid-envelope">,
  ): void {
    if (!this.#isActiveConnection(connection)) {
      this.#onDrop("stale-socket");
      return;
    }
    this.#onDrop(reason);
    this.#incompatible = true;
    this.#connection = null;
    this.#closeSocket(connection.socket, INVALID_EVENT_CLOSE_CODE, "Incompatible realtime event");
    this.#deliverState("incompatible");
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
      const scope = this.#scope;
      if (scope === null || !this.#onEvent({ scope, event: recovery.event })) {
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
    return !this.#stopped && !this.#incompatible && this.#epoch === epoch;
  }

  #isActiveConnection(connection: ActiveConnection): boolean {
    return (
      this.#connection === connection &&
      this.#scope !== null &&
      sameRealtimeScope(this.#scope, connection.scope) &&
      this.#isCurrentEpoch(connection.epoch)
    );
  }

  #sameScope(left: WorkspaceRealtimeScope, right: WorkspaceRealtimeScope): boolean {
    return left.userId === right.userId && left.workspaceId === right.workspaceId;
  }
}

function sameRealtimeScope(left: RealtimeSessionScope, right: RealtimeSessionScope): boolean {
  return (
    left.epoch === right.epoch &&
    left.userId === right.userId &&
    left.workspaceId === right.workspaceId
  );
}
