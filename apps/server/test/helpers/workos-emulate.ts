import { createEmulator, type Emulator, type EmulatorSeedConfig } from "@workos/emulate";
import { WorkOS } from "@workos-inc/node";

import {
  createWorkOSAuthKitIdentityProvider,
  DEFAULT_WORKOS_JWT_ISSUER,
  type WorkOSAuthKitIdentityProvider,
} from "../../src/modules/identity/authkit-provider.js";

export const WORKOS_EMULATE_CLIENT_ID = "client_01TESTEMULATE";
export const WORKOS_EMULATE_REDIRECT_URI = "http://127.0.0.1:3000/v1/auth/workos/callback";

export interface WorkOSEmulateUserSeed {
  readonly id: string;
  readonly email: string;
  readonly emailVerified?: boolean;
  readonly password?: string;
}

export interface WorkOSEmulateFixture {
  readonly emulator: Emulator;
  readonly workos: WorkOS;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly provider: WorkOSAuthKitIdentityProvider;
  /**
   * Completes the emulator's auto-redirect authorize flow and returns the callback code together
   * with the PKCE verifier that produced its challenge. Callers must not invent a verifier.
   */
  authorizeCode(options?: { readonly loginHint?: string }): Promise<{
    readonly code: string;
    readonly state: string;
    readonly codeVerifier: string;
  }>;
  close(): Promise<void>;
}

function toSeedUsers(users: readonly WorkOSEmulateUserSeed[]): EmulatorSeedConfig["users"] {
  return users.map((user) => ({
    id: user.id,
    email: user.email,
    email_verified: user.emailVerified ?? true,
    password: user.password ?? "test-password",
  }));
}

/**
 * Starts WorkOS Emulate and builds the production AuthKit provider against it.
 *
 * The official SDK (and factory) talk to the local emulator over HTTP. Authorization URLs from
 * that SDK are `http://localhost…` and still fail Hype Comms' credential-free HTTPS contracts;
 * exchange, session listing, and JWKS verification use the emulator end to end.
 */
export async function startWorkOSEmulateFixture(options: {
  readonly users: readonly WorkOSEmulateUserSeed[];
  readonly clientId?: string;
  readonly redirectUri?: string;
}): Promise<WorkOSEmulateFixture> {
  const clientId = options.clientId ?? WORKOS_EMULATE_CLIENT_ID;
  const redirectUri = options.redirectUri ?? WORKOS_EMULATE_REDIRECT_URI;
  const emulator = await createEmulator({
    port: 0,
    issuer: DEFAULT_WORKOS_JWT_ISSUER,
    seed: {
      users: toSeedUsers(options.users),
    },
  });

  const host = new URL(emulator.url);
  const workos = new WorkOS(emulator.apiKey, {
    clientId,
    apiHostname: host.hostname,
    port: Number(host.port),
    https: false,
  });

  const provider = createWorkOSAuthKitIdentityProvider({
    apiKey: emulator.apiKey,
    clientId,
    redirectUri,
    jwtIssuer: DEFAULT_WORKOS_JWT_ISSUER,
    apiHostname: host.hostname,
    port: Number(host.port),
    https: false,
  });

  return {
    emulator,
    workos,
    clientId,
    redirectUri,
    provider,
    async authorizeCode(authorizeOptions = {}) {
      const authorization = await workos.userManagement.getAuthorizationUrlWithPKCE({
        provider: "authkit",
        clientId,
        redirectUri,
        ...(authorizeOptions.loginHint === undefined
          ? {}
          : { loginHint: authorizeOptions.loginHint }),
      });
      const authorizeResponse = await fetch(authorization.url, { redirect: "manual" });
      const location = authorizeResponse.headers.get("location");
      if (location === null || authorizeResponse.status !== 302) {
        throw new Error(
          `WorkOS Emulate authorize did not redirect (status ${String(authorizeResponse.status)})`,
        );
      }
      const callback = new URL(location);
      const code = callback.searchParams.get("code");
      const state = callback.searchParams.get("state");
      if (code === null || state === null) {
        throw new Error("WorkOS Emulate authorize redirect omitted code or state");
      }
      return {
        code,
        state,
        codeVerifier: authorization.codeVerifier,
      };
    },
    async close() {
      await emulator.close();
    },
  };
}
