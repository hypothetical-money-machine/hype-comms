import type { EphemeralActivityFrame, PresenceState } from "@hype-comms/contracts";

import type { RealtimePrincipal } from "./auth.js";

export const TYPING_ACTIVITY_TTL_MS = 6_000;
export const PRESENCE_ACTIVITY_REFRESH_MS = 20_000;
const ACTIVITY_MAINTENANCE_INTERVAL_MS = 1_000;

export type CanViewConversation = (
  workspaceId: string,
  userId: string,
  conversationId: string,
) => Promise<boolean>;

export interface EphemeralActivityConnection {
  readonly id: string;
  readonly principal: RealtimePrincipal;
  /** False means the frame was intentionally dropped because the socket cannot accept it now. */
  readonly send: (frame: EphemeralActivityFrame) => boolean;
}

interface RegisteredConnection extends EphemeralActivityConnection {
  presence: Exclude<PresenceState, "offline">;
}

interface TypingMemberState {
  readonly devices: Map<string, number>;
}

interface TypingConversationState {
  readonly members: Map<string, TypingMemberState>;
}

interface WorkspaceTypingState {
  readonly conversations: Map<string, TypingConversationState>;
}

/**
 * Process-local, lossy activity state for authenticated sockets.
 *
 * This class has no database or durable-event dependency. Conversation reads are authorization
 * checks only. Every state entry is owned by a live connection or a short typing deadline, so a
 * process restart, reconnect, or missed frame converges by disappearance rather than replay.
 */
export class EphemeralActivityHub {
  readonly #connections = new Map<string, RegisteredConnection>();
  readonly #typing = new Map<string, WorkspaceTypingState>();
  readonly #maintenance: ReturnType<typeof setInterval>;
  #lastPresenceRefreshAt: number;

  constructor(
    private readonly canViewConversation: CanViewConversation,
    private readonly now: () => number = Date.now,
  ) {
    this.#lastPresenceRefreshAt = now();
    this.#maintenance = setInterval(() => {
      this.#maintain();
    }, ACTIVITY_MAINTENANCE_INTERVAL_MS);
    this.#maintenance.unref();
  }

  register(
    connection: EphemeralActivityConnection,
    initialPresence: Exclude<PresenceState, "offline"> = "online",
  ): void {
    if (!connection.principal.ephemeralActivity || this.#connections.has(connection.id)) return;

    const existingPresence = this.#workspacePresence(connection.principal.workspaceId);
    const previousState = this.#presenceFor(
      connection.principal.workspaceId,
      connection.principal.userId,
    );
    this.#connections.set(connection.id, { ...connection, presence: initialPresence });

    // An automated principal may consume activity when capable, but never contributes a presence
    // state. Human availability is represented only by device-session-backed connections.
    for (const [userId, state] of existingPresence) {
      connection.send(this.#presenceFrame(connection.principal.workspaceId, userId, state));
    }
    if (connection.principal.deviceSessionId === null) return;

    const nextState = this.#presenceFor(
      connection.principal.workspaceId,
      connection.principal.userId,
    );
    if (nextState !== previousState) {
      this.#broadcastPresence(
        connection.principal.workspaceId,
        connection.principal.userId,
        nextState,
      );
    } else {
      connection.send(
        this.#presenceFrame(
          connection.principal.workspaceId,
          connection.principal.userId,
          nextState,
        ),
      );
    }
  }

  setPresence(connectionId: string, state: Exclude<PresenceState, "offline">): void {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined || connection.principal.deviceSessionId === null) return;
    const previousState = this.#presenceFor(
      connection.principal.workspaceId,
      connection.principal.userId,
    );
    connection.presence = state;
    const nextState = this.#presenceFor(
      connection.principal.workspaceId,
      connection.principal.userId,
    );
    if (nextState !== previousState) {
      this.#broadcastPresence(
        connection.principal.workspaceId,
        connection.principal.userId,
        nextState,
      );
    }
  }

  async setTyping(connectionId: string, conversationId: string, typing: boolean): Promise<void> {
    const connection = this.#connections.get(connectionId);
    // Agent-authored typing is intentionally not part of this version. Capable agents can still
    // receive authorized human activity without being presented as available or composing.
    if (connection === undefined || connection.principal.deviceSessionId === null) return;

    if (typing) {
      const authorized = await this.canViewConversation(
        connection.principal.workspaceId,
        connection.principal.userId,
        conversationId,
      );
      if (!authorized || this.#connections.get(connectionId) !== connection) {
        await this.#removeTypingDevice(connection, conversationId);
        return;
      }
      const member = this.#typingMember(
        connection.principal.workspaceId,
        conversationId,
        connection.principal.userId,
      );
      member.devices.set(connectionId, this.now() + TYPING_ACTIVITY_TTL_MS);
      await this.#broadcastTyping(
        connection.principal.workspaceId,
        conversationId,
        connection.principal.userId,
        true,
      );
      return;
    }

    await this.#removeTypingDevice(connection, conversationId);
  }

  disconnect(connectionId: string): void {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) return;
    const previousPresence = this.#presenceFor(
      connection.principal.workspaceId,
      connection.principal.userId,
    );
    this.#connections.delete(connectionId);

    if (connection.principal.deviceSessionId !== null) {
      const nextPresence = this.#presenceFor(
        connection.principal.workspaceId,
        connection.principal.userId,
      );
      if (nextPresence !== previousPresence) {
        this.#broadcastPresence(
          connection.principal.workspaceId,
          connection.principal.userId,
          nextPresence,
        );
      }
    }

    const workspace = this.#typing.get(connection.principal.workspaceId);
    if (workspace === undefined) return;
    for (const [conversationId, conversation] of workspace.conversations) {
      const member = conversation.members.get(connection.principal.userId);
      if (member === undefined || !member.devices.delete(connectionId)) continue;
      if (member.devices.size === 0) {
        conversation.members.delete(connection.principal.userId);
        void this.#broadcastTyping(
          connection.principal.workspaceId,
          conversationId,
          connection.principal.userId,
          false,
        );
      }
      this.#removeEmptyTypingState(connection.principal.workspaceId, conversationId);
    }
  }

  close(): void {
    clearInterval(this.#maintenance);
    this.#connections.clear();
    this.#typing.clear();
  }

  async #removeTypingDevice(
    connection: RegisteredConnection,
    conversationId: string,
  ): Promise<void> {
    const member = this.#typing
      .get(connection.principal.workspaceId)
      ?.conversations.get(conversationId)
      ?.members.get(connection.principal.userId);
    if (member === undefined || !member.devices.delete(connection.id)) return;
    if (member.devices.size === 0) {
      this.#typing
        .get(connection.principal.workspaceId)
        ?.conversations.get(conversationId)
        ?.members.delete(connection.principal.userId);
      await this.#broadcastTyping(
        connection.principal.workspaceId,
        conversationId,
        connection.principal.userId,
        false,
      );
    }
    this.#removeEmptyTypingState(connection.principal.workspaceId, conversationId);
  }

  #maintain(): void {
    const now = this.now();
    for (const [workspaceId, workspace] of this.#typing) {
      for (const [conversationId, conversation] of workspace.conversations) {
        for (const [userId, member] of conversation.members) {
          for (const [connectionId, expiresAt] of member.devices) {
            if (expiresAt <= now) member.devices.delete(connectionId);
          }
          if (member.devices.size === 0) {
            conversation.members.delete(userId);
            void this.#broadcastTyping(workspaceId, conversationId, userId, false);
          }
        }
        this.#removeEmptyTypingState(workspaceId, conversationId);
      }
    }

    if (now - this.#lastPresenceRefreshAt < PRESENCE_ACTIVITY_REFRESH_MS) return;
    this.#lastPresenceRefreshAt = now;
    for (const [workspaceId, states] of this.#allPresence()) {
      for (const [userId, state] of states) this.#broadcastPresence(workspaceId, userId, state);
    }
  }

  #presenceFor(workspaceId: string, userId: string): PresenceState {
    let connected = false;
    for (const connection of this.#connections.values()) {
      if (
        connection.principal.workspaceId !== workspaceId ||
        connection.principal.userId !== userId ||
        connection.principal.deviceSessionId === null
      ) {
        continue;
      }
      connected = true;
      if (connection.presence === "online") return "online";
    }
    return connected ? "away" : "offline";
  }

  #allPresence(): Map<string, Map<string, Exclude<PresenceState, "offline">>> {
    const workspaces = new Map<string, Map<string, Exclude<PresenceState, "offline">>>();
    for (const connection of this.#connections.values()) {
      if (connection.principal.deviceSessionId === null) continue;
      const members = workspaces.get(connection.principal.workspaceId) ?? new Map();
      workspaces.set(connection.principal.workspaceId, members);
      members.set(
        connection.principal.userId,
        this.#presenceFor(connection.principal.workspaceId, connection.principal.userId) as Exclude<
          PresenceState,
          "offline"
        >,
      );
    }
    return workspaces;
  }

  #workspacePresence(workspaceId: string): Map<string, Exclude<PresenceState, "offline">> {
    return this.#allPresence().get(workspaceId) ?? new Map();
  }

  #presenceFrame(workspaceId: string, userId: string, state: PresenceState) {
    return {
      version: 1,
      type: "activity.presence",
      workspaceId,
      userId,
      state,
    } as const;
  }

  #broadcastPresence(workspaceId: string, userId: string, state: PresenceState): void {
    const frame = this.#presenceFrame(workspaceId, userId, state);
    for (const connection of this.#connections.values()) {
      if (connection.principal.workspaceId === workspaceId) connection.send(frame);
    }
  }

  async #broadcastTyping(
    workspaceId: string,
    conversationId: string,
    userId: string,
    typing: boolean,
  ): Promise<void> {
    const recipients = new Map<string, RegisteredConnection[]>();
    for (const connection of this.#connections.values()) {
      if (connection.principal.workspaceId !== workspaceId) continue;
      const devices = recipients.get(connection.principal.userId) ?? [];
      devices.push(connection);
      recipients.set(connection.principal.userId, devices);
    }
    const decisions = await Promise.all(
      [...recipients].map(async ([recipientUserId, devices]) => ({
        devices,
        visible: await this.canViewConversation(workspaceId, recipientUserId, conversationId),
      })),
    );
    const frame = {
      version: 1,
      type: "activity.typing",
      workspaceId,
      conversationId,
      userId,
      typing,
    } as const;
    for (const decision of decisions) {
      if (!decision.visible) continue;
      for (const connection of decision.devices) {
        if (this.#connections.get(connection.id) === connection) connection.send(frame);
      }
    }
  }

  #typingMember(workspaceId: string, conversationId: string, userId: string): TypingMemberState {
    const workspace = this.#typing.get(workspaceId) ?? { conversations: new Map() };
    this.#typing.set(workspaceId, workspace);
    const conversation = workspace.conversations.get(conversationId) ?? { members: new Map() };
    workspace.conversations.set(conversationId, conversation);
    const member = conversation.members.get(userId) ?? { devices: new Map() };
    conversation.members.set(userId, member);
    return member;
  }

  #removeEmptyTypingState(workspaceId: string, conversationId: string): void {
    const workspace = this.#typing.get(workspaceId);
    const conversation = workspace?.conversations.get(conversationId);
    if (workspace === undefined || conversation === undefined || conversation.members.size > 0) {
      return;
    }
    workspace.conversations.delete(conversationId);
    if (workspace.conversations.size === 0) this.#typing.delete(workspaceId);
  }
}
