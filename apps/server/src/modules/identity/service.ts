import { randomUUID } from "node:crypto";

import {
  agentTokenSecretSchema,
  currentUserSchema,
  invitationSchema,
  magicLinkRequestedSchema,
  sessionTokenSchema,
  type Agent,
  type AgentCurrentPrincipal,
  type AgentScope,
  type AgentToken,
  type AuthKitProviderSessionId,
  type CurrentUser,
  type CurrentPrincipal,
  type DeviceSession,
  type Email,
  type EntityId,
  type Invitation,
  type MagicLinkRequested,
  type SessionToken,
} from "@hype-comms/contracts";

import { ApiError } from "../../errors.js";
import type { SignInThrottle } from "../../throttle.js";
import type { EmailSender } from "./email.js";
import type { IdentityRepository, IdentityUser } from "./repository.js";
import { hashToken, issueAgentToken, issueToken } from "./tokens.js";

/** displayNameSchema's upper bound, which is narrower than userSchema.displayName's. */
const DISPLAY_NAME_MAX_LENGTH = 80;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_MEMBERS = 25;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface RedeemedSession {
  readonly token: SessionToken;
  readonly expiresAt: string;
}

export type RefreshedSession = RedeemedSession;

export interface AuthenticatedIdentity {
  readonly currentUser: CurrentPrincipal;
  readonly principalKind: "human" | "agent";
  readonly sessionId?: EntityId;
  readonly agentTokenId?: EntityId;
}

export interface AuthenticatedAgentIdentity extends AuthenticatedIdentity {
  readonly currentUser: AgentCurrentPrincipal;
  readonly principalKind: "agent";
  readonly agentTokenId: EntityId;
  readonly sessionId?: never;
}

export interface AuthenticatedHumanIdentity extends AuthenticatedIdentity {
  readonly currentUser: CurrentUser;
  readonly sessionId: EntityId;
  readonly agentTokenId?: never;
  readonly principalKind: "human";
}

export interface SeedOwnerInput {
  readonly email: Email;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
}

/**
 * Minimal logging surface, kept framework-agnostic. Sign-in delivery must answer identically for
 * every address, so a failure cannot surface to the caller; it still has to be visible to us, or a
 * misconfigured mail transport looks exactly like a working one.
 */
export interface ServiceLogger {
  error(details: Record<string, unknown>, message: string): void;
  warn?(details: Record<string, unknown>, message: string): void;
}

export interface IdentitySecurityEvents {
  tokenReuseDetected(): void;
}

function iso(date: Date): string {
  return date.toISOString();
}

function isExpired(expiresAt: string, now: Date): boolean {
  return Date.parse(expiresAt) <= now.getTime();
}

function unauthenticated(): ApiError {
  return new ApiError(401, "UNAUTHORIZED", "Sign in link or session is invalid");
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505";
}

const AGENT_SCOPE_ORDER: readonly AgentScope[] = [
  "workspace:read",
  "messages:write",
  "conversations:write",
  "read-cursors:write",
];

function usernameBase(email: Email): string {
  const localPart = email.slice(0, email.lastIndexOf("@"));
  const sanitized = localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 80) || "member";
}

function displayName(email: Email): string {
  const localPart = email.slice(0, email.lastIndexOf("@"));
  // Clamped to displayNameSchema's 80 rather than userSchema's 120. The chat channel identifies an
  // author with the narrower schema, so a longer name would store fine and then fail validation on
  // every chat request. A valid address can carry a local part well past 80 characters.
  return localPart.trim().slice(0, DISPLAY_NAME_MAX_LENGTH) || "Member";
}

export class IdentityService {
  readonly #repository: IdentityRepository;
  readonly #emailSender: EmailSender;
  readonly #throttle: SignInThrottle;
  readonly #clock: () => Date;
  readonly #publicAppUrl: string;
  readonly #securityEvents: IdentitySecurityEvents | undefined;

  constructor(
    repository: IdentityRepository,
    emailSender: EmailSender,
    throttle: SignInThrottle,
    clock: () => Date,
    publicAppUrl: string,
    securityEvents?: IdentitySecurityEvents,
  ) {
    this.#repository = repository;
    this.#emailSender = emailSender;
    this.#throttle = throttle;
    this.#clock = clock;
    this.#publicAppUrl = publicAppUrl;
    this.#securityEvents = securityEvents;
  }

  async requestMagicLink(
    email: Email,
    clientIp: string,
    logger?: ServiceLogger,
  ): Promise<MagicLinkRequested> {
    const accepted = magicLinkRequestedSchema.parse({ status: "accepted" });
    const ipKey = `ip:${clientIp}`;
    const emailKey = `email:${email}`;
    if (this.#throttle.retryAfterMs(ipKey) > 0 || this.#throttle.retryAfterMs(emailKey) > 0) {
      return accepted;
    }
    this.#throttle.recordFailure(ipKey);
    this.#throttle.recordFailure(emailKey);

    try {
      const now = this.#clock();
      const user = await this.#repository.findUserByEmail(email);
      const membership =
        user === null ? null : await this.#repository.findActiveMembershipByUserId(user.id);
      const pendingInvitation = await this.#repository.findPendingInvitationByEmail(email);
      const invitation =
        pendingInvitation !== null && !isExpired(pendingInvitation.expiresAt, now)
          ? pendingInvitation
          : null;
      if (membership === null && invitation === null) return accepted;

      const issued = issueToken();
      const normalExpiry = new Date(now.getTime() + MAGIC_LINK_TTL_MS);
      const expiresAt =
        invitation === null || Date.parse(invitation.expiresAt) >= normalExpiry.getTime()
          ? normalExpiry
          : new Date(invitation.expiresAt);
      await this.#repository.insertMagicLink({
        id: randomUUID(),
        tokenHash: issued.hash,
        email,
        invitationId: invitation?.id ?? null,
        expiresAt: iso(expiresAt),
        createdAt: iso(now),
      });

      const url = new URL("/auth/magic-link", this.#publicAppUrl);
      url.searchParams.set("token", issued.token);
      await this.#emailSender.sendMagicLink({ to: email, url: url.toString(), expiresAt });
    } catch (error) {
      // A well-formed request always has the same response, including when delivery or persistence
      // fails. Varying the response here would reveal which email addresses are real members. The
      // failure is logged rather than swallowed: without this, a broken mail transport is
      // indistinguishable from a working one, and every sign-in silently stops arriving.
      logger?.error({ err: error }, "Magic-link delivery failed");
    }

    return accepted;
  }

  async redeemMagicLink(token: string, label: string | null): Promise<RedeemedSession> {
    const now = this.#clock();
    // Consumption happens before every other check and outside the activation transaction. A later
    // expiry, invitation, capacity, or persistence failure must never roll back the token burn.
    const consumed = await this.#repository.consumeMagicLink(hashToken(token), iso(now));
    if (consumed.status !== "consumed" || isExpired(consumed.magicLink.expiresAt, now)) {
      throw unauthenticated();
    }

    const user =
      consumed.magicLink.invitationId === null
        ? await this.#resolveActiveUser(consumed.magicLink.email)
        : await this.#activateInvitation(
            consumed.magicLink.invitationId,
            consumed.magicLink.email,
            now,
          );
    return this.#createSession(user.id, label, now);
  }

  async authenticate(sessionToken: string): Promise<CurrentUser | null> {
    return (await this.authenticateContext(sessionToken))?.currentUser ?? null;
  }

  async authenticateContext(sessionToken: string): Promise<AuthenticatedHumanIdentity | null> {
    const now = this.#clock();
    const session = await this.#repository.findDeviceSessionByTokenHash(hashToken(sessionToken));
    if (session === null || isExpired(session.expiresAt, now)) return null;
    const currentUser = await this.#currentUser(session.userId);
    return currentUser === null
      ? null
      : { currentUser, sessionId: session.id, principalKind: "human" };
  }

  async authenticateAgentContext(agentToken: string): Promise<AuthenticatedAgentIdentity | null> {
    const parsed = agentTokenSecretSchema.safeParse(agentToken);
    if (!parsed.success) return null;
    const authenticated = await this.#repository.authenticateAgentToken(
      hashToken(parsed.data),
      iso(this.#clock()),
    );
    if (authenticated === null) return null;
    return {
      currentUser: authenticated.principal,
      principalKind: "agent",
      agentTokenId: authenticated.tokenId,
    };
  }

  async refreshSession(sessionToken: string, logger?: ServiceLogger): Promise<RefreshedSession> {
    const now = this.#clock();
    // The refresh credential is a sliding window, not a countdown to a fixed date: every rotation
    // moves the expiry a full TTL past now, so a device that keeps refreshing never has to redeem
    // another sign-in link. The repository also detects historical-token reuse and revokes only
    // that device lineage, while distinguishing a genuinely concurrent rotation.
    const next = issueToken();
    const renewedExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const rotated = await this.#repository.refreshDeviceSession({
      previousTokenHash: hashToken(sessionToken),
      nextTokenHash: next.hash,
      refreshedAt: iso(now),
      expiresAt: iso(renewedExpiresAt),
    });
    if (rotated.status === "reused") {
      this.#securityEvents?.tokenReuseDetected();
      logger?.warn?.(
        { deviceSessionId: rotated.deviceSessionId },
        "Refresh-token reuse detected; device-session lineage revoked",
      );
    }
    if (rotated.status !== "rotated") throw unauthenticated();
    return {
      token: sessionTokenSchema.parse(next.token),
      expiresAt: rotated.session.expiresAt,
    };
  }

  async signOut(sessionToken: string): Promise<AuthKitProviderSessionId | null> {
    return this.#repository.revokeDeviceSessionByTokenHash(
      hashToken(sessionToken),
      iso(this.#clock()),
    );
  }

  async listDevices(userId: EntityId): Promise<DeviceSession[]> {
    return this.#repository.listDeviceSessions(userId);
  }

  async revokeDevice(userId: EntityId, sessionId: EntityId): Promise<boolean> {
    const revoked = await this.#repository.revokeDeviceSessionForUser(
      sessionId,
      userId,
      iso(this.#clock()),
    );
    return revoked !== null;
  }

  async deleteExpiredDeviceSessionTokenHistory(): Promise<number> {
    return this.#repository.deleteExpiredDeviceSessionTokenHistory(iso(this.#clock()));
  }

  async createInvitation(actorUserId: EntityId, email: Email, role: "member"): Promise<Invitation> {
    const now = this.#clock();
    return this.#repository.transaction(async (repository) => {
      const actorMembership = await this.#requireLockedOwner(
        actorUserId,
        repository,
        "Only a workspace owner may invite members",
      );
      if (
        (await repository.countActiveMembers(actorMembership.workspaceId)) >= MAX_ACTIVE_MEMBERS
      ) {
        throw new ApiError(409, "CONFLICT", "The workspace is at capacity");
      }

      await repository.expireInvitations(iso(now));
      const existing = await repository.findPendingInvitation(actorMembership.workspaceId, email);
      if (existing !== null) {
        throw new ApiError(409, "CONFLICT", "A pending invitation already exists");
      }
      const invitation = await repository.insertInvitation({
        id: randomUUID(),
        workspaceId: actorMembership.workspaceId,
        email,
        role,
        invitedBy: actorUserId,
        expiresAt: iso(new Date(now.getTime() + INVITATION_TTL_MS)),
      });
      return invitationSchema.parse(invitation);
    });
  }

  async listInvitations(actorUserId: EntityId): Promise<Invitation[]> {
    const owner = await this.#requireOwner(actorUserId, this.#repository);
    await this.#repository.expireInvitations(iso(this.#clock()));
    return this.#repository.listInvitations(owner.workspaceId);
  }

  async revokeInvitation(actorUserId: EntityId, invitationId: EntityId): Promise<boolean> {
    return this.#repository.transaction(async (repository) => {
      const owner = await this.#requireOwner(actorUserId, repository);
      const invitation = await repository.findInvitationById(invitationId);
      if (invitation === null || invitation.workspaceId !== owner.workspaceId) return false;
      return (await repository.markInvitationRevoked(invitationId)) !== null;
    });
  }

  async listAgents(actorUserId: EntityId): Promise<Agent[]> {
    const membership = await this.#requireOwner(actorUserId, this.#repository);
    return this.#repository.listAgents(membership.workspaceId);
  }

  async createAgent(
    actorUserId: EntityId,
    input: { readonly username: string; readonly displayName: string },
  ): Promise<Agent> {
    return this.#repository.transaction(async (repository) => {
      const owner = await this.#requireLockedOwner(
        actorUserId,
        repository,
        "Only a workspace owner may create agents",
      );
      if ((await repository.countActiveMembers(owner.workspaceId)) >= MAX_ACTIVE_MEMBERS) {
        throw new ApiError(409, "CONFLICT", "The workspace is at capacity");
      }
      if ((await repository.findUserByUsername(input.username)) !== null) {
        throw new ApiError(409, "CONFLICT", "That username is already in use");
      }
      try {
        return await repository.insertAgent({
          id: randomUUID(),
          workspaceId: owner.workspaceId,
          username: input.username,
          displayName: input.displayName,
          createdBy: actorUserId,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "CONFLICT", "That username is already in use");
        }
        throw error;
      }
    });
  }

  async disableAgent(actorUserId: EntityId, agentUserId: EntityId): Promise<boolean> {
    return this.#repository.transaction(async (repository) => {
      const candidate = await this.#requireOwner(
        actorUserId,
        repository,
        "Only a workspace owner may disable agents",
      );
      // Delivery locks this target row before allocating a workspace sequence. Match that order
      // before #requireLockedOwner takes the workspace row so neither transaction can deadlock.
      await repository.lockWorkspaceMembership(candidate.workspaceId, agentUserId);
      const owner = await this.#requireLockedOwner(
        actorUserId,
        repository,
        "Only a workspace owner may disable agents",
      );
      if (owner.workspaceId !== candidate.workspaceId) {
        throw new ApiError(403, "FORBIDDEN", "Only a workspace owner may disable agents");
      }
      if ((await repository.findAgent(owner.workspaceId, agentUserId)) === null) return false;
      await repository.disableAgent(
        owner.workspaceId,
        agentUserId,
        iso(this.#clock()),
        actorUserId,
      );
      return true;
    });
  }

  async listAgentTokens(actorUserId: EntityId, agentUserId: EntityId): Promise<AgentToken[]> {
    const owner = await this.#requireOwner(actorUserId, this.#repository);
    if ((await this.#repository.findAgent(owner.workspaceId, agentUserId)) === null) {
      throw new ApiError(404, "NOT_FOUND", "Agent not found");
    }
    return this.#repository.listAgentTokens(owner.workspaceId, agentUserId);
  }

  async createAgentToken(
    actorUserId: EntityId,
    agentUserId: EntityId,
    input: { readonly label: string; readonly scopes: readonly AgentScope[] },
  ): Promise<{ readonly token: string; readonly agentToken: AgentToken }> {
    return this.#repository.transaction(async (repository) => {
      const owner = await this.#requireLockedOwner(
        actorUserId,
        repository,
        "Only a workspace owner may create agent tokens",
      );
      const agent = await repository.findAgent(owner.workspaceId, agentUserId);
      if (agent === null) throw new ApiError(404, "NOT_FOUND", "Agent not found");
      if (agent.status !== "active") {
        throw new ApiError(409, "CONFLICT", "Disabled agents cannot receive new tokens");
      }

      const uniqueScopes = new Set(input.scopes);
      const scopes = AGENT_SCOPE_ORDER.filter((scope) => uniqueScopes.has(scope));
      const issued = issueAgentToken();
      const agentToken = await repository.insertAgentToken({
        id: randomUUID(),
        workspaceId: owner.workspaceId,
        agentUserId,
        tokenHash: issued.hash,
        label: input.label,
        scopes,
        createdBy: actorUserId,
        createdAt: iso(this.#clock()),
      });
      return { token: agentTokenSecretSchema.parse(issued.token), agentToken };
    });
  }

  async revokeAgentToken(
    actorUserId: EntityId,
    agentUserId: EntityId,
    tokenId: EntityId,
  ): Promise<boolean> {
    return this.#repository.transaction(async (repository) => {
      const owner = await this.#requireLockedOwner(
        actorUserId,
        repository,
        "Only a workspace owner may revoke agent tokens",
      );
      if ((await repository.findAgent(owner.workspaceId, agentUserId)) === null) return false;
      return repository.revokeAgentToken(
        owner.workspaceId,
        agentUserId,
        tokenId,
        iso(this.#clock()),
      );
    });
  }

  async seedOwner(input: SeedOwnerInput): Promise<void> {
    await this.#repository.transaction(async (repository) => {
      await repository.lockWorkspaceIdentity();
      if ((await repository.findWorkspaceBySlug(input.workspaceSlug)) !== null) return;

      const user =
        (await repository.findUserByEmail(input.email)) ??
        (await this.#insertUser(repository, input.email));
      const workspace = await repository.insertWorkspace({
        id: randomUUID(),
        name: input.workspaceName,
        slug: input.workspaceSlug,
        createdBy: user.id,
      });
      await repository.upsertMembership({
        workspaceId: workspace.id,
        userId: user.id,
        role: "owner",
        status: "active",
      });
    });
  }

  async #requireOwner(
    actorUserId: EntityId,
    repository: IdentityRepository,
    message = "A workspace owner session is required",
  ) {
    const membership = await repository.findActiveMembershipByUserId(actorUserId);
    if (membership === null || membership.role !== "owner") {
      throw new ApiError(403, "FORBIDDEN", message);
    }
    return membership;
  }

  /**
   * Take the workspace lock, then re-check ownership inside it. The first check picks the
   * workspace to lock; only the second one is authoritative, because a concurrent transaction
   * can revoke the actor's membership between them.
   */
  async #requireLockedOwner(
    actorUserId: EntityId,
    repository: IdentityRepository,
    message: string,
  ) {
    const candidate = await this.#requireOwner(actorUserId, repository, message);
    if (!(await repository.lockWorkspace(candidate.workspaceId))) {
      throw new ApiError(403, "FORBIDDEN", message);
    }
    const owner = await this.#requireOwner(actorUserId, repository, message);
    if (owner.workspaceId !== candidate.workspaceId) {
      throw new ApiError(403, "FORBIDDEN", message);
    }
    return owner;
  }

  async #resolveActiveUser(email: Email): Promise<IdentityUser> {
    const user = await this.#repository.findUserByEmail(email);
    if (user === null) throw unauthenticated();
    const membership = await this.#repository.findActiveMembershipByUserId(user.id);
    if (membership === null) throw unauthenticated();
    return user;
  }

  async #activateInvitation(
    invitationId: EntityId,
    email: Email,
    now: Date,
  ): Promise<IdentityUser> {
    return this.#repository.transaction(async (repository) => {
      // Serialize redemption before resolving a possibly-new user, then use membership before
      // workspace for an existing row. The invitation lock also prevents concurrent links for
      // the same invitation from racing user creation before either reaches the workspace lock.
      const invitation = await repository.findInvitationById(invitationId, true);
      if (
        invitation === null ||
        invitation.email !== email ||
        invitation.status !== "pending" ||
        isExpired(invitation.expiresAt, now)
      ) {
        throw unauthenticated();
      }
      const user =
        (await repository.findUserByEmail(email)) ?? (await this.#insertUser(repository, email));
      // Existing memberships use the same membership-before-workspace order as delivery and
      // revocation. A new user has no row to lock and cannot be an authenticated sender yet.
      await repository.lockWorkspaceMembership(invitation.workspaceId, user.id);
      if (!(await repository.lockWorkspace(invitation.workspaceId))) throw unauthenticated();

      const membership = await repository.findMembership(invitation.workspaceId, user.id);
      if (
        membership?.status !== "active" &&
        (await repository.countActiveMembers(invitation.workspaceId)) >= MAX_ACTIVE_MEMBERS
      ) {
        throw new ApiError(409, "CONFLICT", "The workspace is at capacity");
      }
      const accepted = await repository.markInvitationAccepted(invitation.id, iso(now));
      if (accepted === null) throw unauthenticated();
      await repository.upsertMembership({
        workspaceId: invitation.workspaceId,
        userId: user.id,
        // Invitation activation grants access; it must not alter the privileges of a membership
        // that is already active. Non-active and missing memberships still receive the invited role.
        role: membership?.status === "active" ? membership.role : invitation.role,
        status: "active",
      });
      return user;
    });
  }

  async #insertUser(repository: IdentityRepository, email: Email): Promise<IdentityUser> {
    const base = usernameBase(email);
    let suffix = 1;
    while (true) {
      const suffixText = suffix === 1 ? "" : `-${suffix}`;
      const username = `${base.slice(0, 80 - suffixText.length)}${suffixText}`;
      if ((await repository.findUserByUsername(username)) === null) {
        return repository.insertUser({
          id: randomUUID(),
          email,
          username,
          displayName: displayName(email),
          avatarUrl: null,
        });
      }
      suffix += 1;
    }
  }

  async #createSession(
    userId: EntityId,
    label: string | null,
    now: Date,
  ): Promise<RedeemedSession> {
    const issued = issueToken();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.#repository.insertDeviceSession({
      id: randomUUID(),
      userId,
      tokenHash: issued.hash,
      label,
      createdAt: iso(now),
      lastSeenAt: iso(now),
      expiresAt: iso(expiresAt),
    });
    return {
      token: sessionTokenSchema.parse(issued.token),
      expiresAt: iso(expiresAt),
    };
  }

  async #currentUser(userId: EntityId): Promise<CurrentUser | null> {
    const [user, membership] = await Promise.all([
      this.#repository.findUserById(userId),
      this.#repository.findActiveMembershipByUserId(userId),
    ]);
    if (user === null || user.kind !== "human" || user.email === null || membership === null) {
      return null;
    }
    const { email, ...publicUser } = user;
    return currentUserSchema.parse({
      user: publicUser,
      email,
      workspaceId: membership.workspaceId,
      role: membership.role,
    });
  }
}
