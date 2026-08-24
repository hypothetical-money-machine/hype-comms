import {
  authKitLogoutUrlSchema,
  authKitProviderSessionIdSchema,
  desktopAuthVariantSchema,
  type AuthDesktopState,
  type AuthKitLogoutUrl,
  type AuthKitProviderSessionId,
  type AuthHandoffCode,
  type AuthPkceCodeChallenge,
  type AuthProviderAuthorizationCode,
  type AuthProviderState,
  type CreateDesktopAuthorizationResponse,
  type DesktopAuthVariant,
  type ExchangeAuthHandoffRequest,
} from "@hype-comms/contracts";

import { ApiError } from "../../errors.js";
import {
  AuthKitIdentityRejectedError,
  AuthKitProviderUnavailableError,
  type AuthKitIdentityProvider,
} from "./authkit-provider.js";
import {
  AuthKitAdmissionDeniedError,
  AuthKitCredentialRejectedError,
  type AuthKitRepository,
} from "./authkit-repository.js";
import type { RedeemedSession } from "./service.js";

const PROVIDER_TRANSACTION_TTL_MS = 10 * 60 * 1_000;

export type AuthKitCallbackCompletion =
  | {
      readonly kind: "success";
      readonly handoffCode: AuthHandoffCode;
      readonly desktopState: AuthDesktopState;
      readonly desktopAuthVariant: DesktopAuthVariant;
    }
  | {
      readonly kind: "error";
      readonly failureCategory?: AuthKitCallbackFailureCategory;
      readonly desktopState: AuthDesktopState;
      readonly desktopAuthVariant: DesktopAuthVariant;
    }
  | {
      readonly kind: "error";
      readonly failureCategory?: AuthKitCallbackFailureCategory;
    };

export type AuthKitCallbackFailureCategory =
  "identity_rejected" | "provider_unavailable" | "admission_denied" | "internal";

function classifyCallbackFailure(error: unknown): AuthKitCallbackFailureCategory {
  if (error instanceof AuthKitIdentityRejectedError) return "identity_rejected";
  if (error instanceof AuthKitProviderUnavailableError) return "provider_unavailable";
  if (error instanceof AuthKitAdmissionDeniedError) return "admission_denied";
  return "internal";
}

export interface AuthKitSessionReconciliationResult {
  readonly checked: number;
  readonly revoked: number;
  /** Provider subjects preserved locally because their complete upstream state was unavailable. */
  readonly unavailableSubjects: number;
}

export class AuthKitService {
  readonly #provider: AuthKitIdentityProvider;
  readonly #repository: AuthKitRepository;
  readonly #now: () => Date;

  constructor(options: {
    readonly provider: AuthKitIdentityProvider;
    readonly repository: AuthKitRepository;
    readonly now?: () => Date;
  }) {
    this.#provider = options.provider;
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
  }

  async beginDesktopAuthorization(input: {
    readonly codeChallenge: AuthPkceCodeChallenge;
    readonly desktopState: AuthDesktopState;
    readonly desktopAuthVariant: DesktopAuthVariant;
  }): Promise<CreateDesktopAuthorizationResponse> {
    try {
      const authorization = await this.#provider.createAuthorization();
      const createdAt = this.#now();
      await this.#repository.createTransaction({
        providerState: authorization.state,
        providerCodeVerifier: authorization.codeVerifier,
        desktopCodeChallenge: input.codeChallenge,
        desktopState: input.desktopState,
        desktopAuthVariant: desktopAuthVariantSchema.parse(input.desktopAuthVariant),
        expiresAt: new Date(createdAt.getTime() + PROVIDER_TRANSACTION_TTL_MS),
      });
      return { authorizationUrl: authorization.authorizationUrl };
    } catch {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Authentication is temporarily unavailable");
    }
  }

  async completeCallback(
    input:
      | {
          readonly kind: "success";
          readonly code: AuthProviderAuthorizationCode;
          readonly providerState: AuthProviderState;
          readonly ipAddress?: string;
          readonly userAgent?: string;
        }
      | {
          readonly kind: "error";
          readonly providerState: AuthProviderState;
        },
  ): Promise<AuthKitCallbackCompletion> {
    let transaction: Awaited<ReturnType<AuthKitRepository["consumeTransaction"]>>;
    try {
      // Consume first. A replay can never drive a second provider exchange, even when the first
      // exchange or local admission fails after WorkOS accepted the authorization code.
      transaction = await this.#repository.consumeTransaction(input.providerState, this.#now());
    } catch {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Authentication is temporarily unavailable");
    }
    if (transaction === null) {
      return { kind: "error", failureCategory: "internal" };
    }
    if (input.kind === "error") {
      return {
        kind: "error",
        desktopState: transaction.desktopState,
        desktopAuthVariant: transaction.desktopAuthVariant,
      };
    }

    try {
      const identity = await this.#provider.authenticateCode({
        code: input.code,
        codeVerifier: transaction.providerCodeVerifier,
        ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      });
      const admitted = await this.#repository.admitIdentity({
        providerSubject: identity.subject,
        verifiedEmail: identity.verifiedEmail,
        workosSessionId: identity.providerSessionId,
        desktopCodeChallenge: transaction.desktopCodeChallenge,
        now: this.#now(),
      });
      return {
        kind: "success",
        handoffCode: admitted.handoffCode,
        desktopState: transaction.desktopState,
        desktopAuthVariant: transaction.desktopAuthVariant,
      };
    } catch (error) {
      // Once provider state is consumed every failure is terminal. Collapse identity, admission,
      // capacity, and dependency details into the same credential-free desktop callback.
      return {
        kind: "error",
        failureCategory: classifyCallbackFailure(error),
        desktopState: transaction.desktopState,
        desktopAuthVariant: transaction.desktopAuthVariant,
      };
    }
  }

  async exchangeHandoff(
    input: ExchangeAuthHandoffRequest,
    userAgent: string | undefined,
  ): Promise<RedeemedSession> {
    const installation = input.installationId.slice(0, 8);
    const clientLabel = `${input.platform} Hype Comms ${input.appVersion} (${installation})`;
    const label = (userAgent === undefined ? clientLabel : `${clientLabel}; ${userAgent}`).slice(
      0,
      200,
    );

    try {
      return await this.#repository.exchangeHandoff({
        handoffCode: input.code,
        codeVerifier: input.codeVerifier,
        label,
        now: this.#now(),
      });
    } catch (error) {
      if (error instanceof AuthKitCredentialRejectedError) {
        throw new ApiError(401, "UNAUTHORIZED", "Authentication could not be completed");
      }
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Authentication is temporarily unavailable");
    }
  }

  /** Provider metadata is optional: local sign-out has already committed before this is called. */
  createLogoutUrl(providerSessionId: AuthKitProviderSessionId): AuthKitLogoutUrl | null {
    try {
      return authKitLogoutUrlSchema.parse(this.#provider.createLogoutUrl(providerSessionId));
    } catch {
      return null;
    }
  }

  /**
   * Reconciles only an immutable snapshot of currently active local rows. A session created while
   * the provider list is in flight is intentionally deferred to the next pass rather than being
   * judged against a stale upstream response.
   */
  async reconcileActiveSessions(): Promise<AuthKitSessionReconciliationResult> {
    const snapshot = await this.#repository.listActiveAuthKitDeviceSessions(this.#now());
    const bySubject = new Map<string, typeof snapshot>();
    for (const session of snapshot) {
      const sessions = bySubject.get(session.providerSubject) ?? [];
      sessions.push(session);
      bySubject.set(session.providerSubject, sessions);
    }

    const revokeIds: string[] = [];
    let checked = 0;
    let unavailableSubjects = 0;
    for (const [providerSubject, sessions] of bySubject) {
      try {
        const activeIds = await this.#provider.listActiveSessionIds(providerSubject);
        checked += sessions.length;
        for (const session of sessions) {
          if (!activeIds.has(authKitProviderSessionIdSchema.parse(session.workosSessionId))) {
            revokeIds.push(session.deviceSessionId);
          }
        }
      } catch {
        // An incomplete provider response is not evidence of revocation. Preserve this subject's
        // local rows and let the next bounded pass retry them.
        unavailableSubjects += 1;
      }
    }

    const revoked = await this.#repository.revokeAuthKitDeviceSessions(revokeIds, this.#now());
    return { checked, revoked, unavailableSubjects };
  }

  async deleteExpiredState(): Promise<void> {
    await this.#repository.deleteExpiredState(this.#now());
  }
}
