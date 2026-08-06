import { randomUUID } from "node:crypto";

import {
  currentUserSchema,
  invitationSchema,
  magicLinkRequestedSchema,
  sessionTokenSchema,
  type CurrentUser,
  type DeviceSession,
  type Email,
  type EntityId,
  type Invitation,
  type MagicLinkRequested,
  type SessionToken,
} from "@hmm-chat/contracts";

import { ApiError } from "../../errors.js";
import type { SignInThrottle } from "../../throttle.js";
import type { EmailSender } from "./email.js";
import type { IdentityRepository, IdentityUser } from "./repository.js";
import { hashToken, issueToken } from "./tokens.js";

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
  readonly currentUser: CurrentUser;
  readonly sessionId: EntityId;
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

  constructor(
    repository: IdentityRepository,
    emailSender: EmailSender,
    throttle: SignInThrottle,
    clock: () => Date,
    publicAppUrl: string,
  ) {
    this.#repository = repository;
    this.#emailSender = emailSender;
    this.#throttle = throttle;
    this.#clock = clock;
    this.#publicAppUrl = publicAppUrl;
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

  async authenticateContext(sessionToken: string): Promise<AuthenticatedIdentity | null> {
    const now = this.#clock();
    const session = await this.#repository.findDeviceSessionByTokenHash(hashToken(sessionToken));
    if (session === null || isExpired(session.expiresAt, now)) return null;
    const currentUser = await this.#currentUser(session.userId);
    return currentUser === null
      ? null
      : { currentUser, sessionId: session.id, principalKind: "human" };
  }

  async refreshSession(sessionToken: string): Promise<RefreshedSession> {
    const now = this.#clock();
    const previousHash = hashToken(sessionToken);
    const session = await this.#repository.findDeviceSessionByTokenHash(previousHash);
    if (session === null || isExpired(session.expiresAt, now)) throw unauthenticated();

    // The refresh credential is a sliding window, not a countdown to a fixed date: every rotation
    // moves the expiry a full TTL past now, so a device that keeps refreshing never has to redeem
    // another sign-in link. Rotation still refuses a revoked or already-expired session, so this
    // cannot revive one, and it stays a 30-day window for a device that goes quiet.
    const next = issueToken();
    const renewedExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const rotated = await this.#repository.rotateDeviceSession(
      previousHash,
      next.hash,
      iso(now),
      iso(renewedExpiresAt),
    );
    if (rotated.status !== "rotated" || isExpired(rotated.session.expiresAt, now)) {
      throw unauthenticated();
    }
    return {
      token: sessionTokenSchema.parse(next.token),
      expiresAt: rotated.session.expiresAt,
    };
  }

  async signOut(sessionToken: string): Promise<void> {
    const session = await this.#repository.findDeviceSessionByTokenHash(hashToken(sessionToken));
    if (session !== null) {
      await this.#repository.revokeDeviceSession(session.id, iso(this.#clock()));
    }
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

  async createInvitation(actorUserId: EntityId, email: Email, role: "member"): Promise<Invitation> {
    const now = this.#clock();
    return this.#repository.transaction(async (repository) => {
      const actorMembership = await repository.findActiveMembershipByUserId(actorUserId);
      if (actorMembership === null || actorMembership.role !== "owner") {
        throw new ApiError(403, "FORBIDDEN", "Only a workspace owner may invite members");
      }
      if (!(await repository.lockWorkspace(actorMembership.workspaceId))) {
        throw new ApiError(403, "FORBIDDEN", "Only a workspace owner may invite members");
      }
      const membership = await repository.findMembership(actorMembership.workspaceId, actorUserId);
      if (membership?.status !== "active" || membership.role !== "owner") {
        throw new ApiError(403, "FORBIDDEN", "Only a workspace owner may invite members");
      }
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
      const invitation = await repository.findInvitationById(invitationId);
      if (
        invitation === null ||
        invitation.email !== email ||
        invitation.status !== "pending" ||
        isExpired(invitation.expiresAt, now)
      ) {
        throw unauthenticated();
      }
      if (!(await repository.lockWorkspace(invitation.workspaceId))) throw unauthenticated();

      const user =
        (await repository.findUserByEmail(email)) ?? (await this.#insertUser(repository, email));
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
