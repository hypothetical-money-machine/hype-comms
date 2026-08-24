import {
  currentPrincipalSchema,
  currentUserSchema,
  deviceSessionSchema,
  entityIdSchema,
  magicLinkRequestedSchema,
  requestMagicLinkSchema,
  sessionTokenSchema,
  verifyMagicLinkSchema,
} from "@hype-comms/contracts";

import { parseCommandArguments, requirePositionals } from "../argv.js";
import { ApiClient, sessionTokenFromHeaders } from "../client.js";
import {
  agentTokenSchema,
  loadProfileStore,
  resolveProfile,
  saveProfile,
  saveProfileStore,
  validateProfileName,
  withProfileLock,
} from "../config.js";
import { clientFromContext } from "../context.js";
import { UsageError, contractError } from "../errors.js";
import { readPrivateValue } from "../input.js";
import { writeResult } from "../output.js";
import type { CommandContext } from "../types.js";

export async function authCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  if (subcommand === "request-magic-link") {
    const parsed = parseCommandArguments(args, {});
    const [email] = requirePositionals(parsed, 1);
    const client = await clientFromContext(context);
    const response = await client.request({
      method: "POST",
      path: "/v1/auth/magic-link",
      body: { email: email! },
      requestSchema: requestMagicLinkSchema,
      responseSchema: magicLinkRequestedSchema,
      includeCredential: false,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }

  if (subcommand === "exchange") {
    requirePositionals(parseCommandArguments(args, {}), 0);
    const token = await readPrivateValue(context.runtime.io, "Magic-link token");
    const input = verifyMagicLinkSchema.safeParse({ token });
    if (!input.success) throw new UsageError("The magic-link token is invalid", "INVALID_TOKEN");
    const profile = await resolveProfile(context.runtime, context.options, {
      ignoreEnvironmentToken: true,
    });
    const client = new ApiClient({
      profile: { ...profile, credentialFromEnvironment: false },
      fetch: context.runtime.fetch,
      timeoutMs: context.options.timeoutMs,
    });
    const result = await client.requestWithResponse({
      method: "POST",
      path: "/v1/auth/session",
      body: input.data,
      requestSchema: verifyMagicLinkSchema,
      responseSchema: currentUserSchema,
      includeCredential: false,
    });
    const sessionToken = sessionTokenFromHeaders(result.response.headers);
    const parsedSession = sessionTokenSchema.safeParse(sessionToken);
    if (!parsedSession.success) {
      throw contractError("The server did not provide a valid session credential");
    }
    await saveProfile(context.runtime, profile.name, {
      apiOrigin: profile.apiOrigin,
      credential: { kind: "human", sessionToken: parsedSession.data },
    });
    writeResult(context.runtime.io, result.data, context.options.json);
    return;
  }

  if (subcommand === "login-agent") {
    const parsed = parseCommandArguments(args, { save: { kind: "boolean" } });
    requirePositionals(parsed, 0);
    const environmentToken = context.runtime.env.HYPE_COMMS_TOKEN;
    const token =
      environmentToken !== undefined && environmentToken !== ""
        ? environmentToken
        : await readPrivateValue(context.runtime.io, "Agent token");
    const parsedToken = agentTokenSchema.safeParse(token);
    if (!parsedToken.success) throw new UsageError("The agent token is invalid", "INVALID_TOKEN");
    const profile = await resolveProfile(context.runtime, context.options, {
      ignoreEnvironmentToken: true,
    });
    const client = new ApiClient({
      profile: {
        ...profile,
        credential: { kind: "agent", token: parsedToken.data },
        credentialOrigin: profile.apiOrigin,
        credentialFromEnvironment: environmentToken !== undefined && environmentToken !== "",
      },
      fetch: context.runtime.fetch,
      timeoutMs: context.options.timeoutMs,
    });
    const principal = await client.request({
      path: "/v1/auth/me",
      responseSchema: currentPrincipalSchema,
    });
    if (!("type" in principal) || principal.type !== "agent") {
      throw contractError("The supplied credential did not authenticate an agent");
    }
    const saveRequested = parsed.options.save === true;
    if (saveRequested && environmentToken !== undefined && environmentToken !== "") {
      throw new UsageError(
        "Environment credentials are never persisted; pipe the token through stdin to save it",
        "ENVIRONMENT_CREDENTIAL_NOT_SAVED",
      );
    }
    if (saveRequested) {
      await saveProfile(context.runtime, profile.name, {
        apiOrigin: profile.apiOrigin,
        credential: { kind: "agent", token: parsedToken.data },
      });
    }
    writeResult(
      context.runtime.io,
      { principal, profile: profile.name, saved: saveRequested },
      context.options.json,
    );
    return;
  }

  if (subcommand === "whoami") {
    requirePositionals(parseCommandArguments(args, {}), 0);
    const principal = await (
      await clientFromContext(context)
    ).request({
      path: "/v1/auth/me",
      responseSchema: currentPrincipalSchema,
    });
    writeResult(context.runtime.io, principal, context.options.json);
    return;
  }

  if (subcommand === "refresh") {
    requirePositionals(parseCommandArguments(args, {}), 0);
    const result = await withProfileLock(context.runtime, async (directory) => {
      const store = await loadProfileStore(directory);
      const name = validateProfileName(
        context.options.profile ?? context.runtime.env.HYPE_COMMS_PROFILE ?? store.defaultProfile,
      );
      const stored = store.profiles[name];
      if (stored?.credential?.kind !== "human") {
        throw new UsageError("The selected profile has no human session", "HUMAN_SESSION_REQUIRED");
      }
      const profile = await resolveProfile(context.runtime, context.options, {
        ignoreEnvironmentToken: true,
      });
      if (profile.credentialOrigin !== profile.apiOrigin) {
        throw new UsageError(
          "The saved credential belongs to a different API origin; refresh from its saved profile origin",
          "CREDENTIAL_ORIGIN_MISMATCH",
        );
      }
      const client = new ApiClient({
        profile,
        fetch: context.runtime.fetch,
        timeoutMs: context.options.timeoutMs,
      });
      const response = await client.requestEmpty({
        method: "POST",
        path: "/v1/auth/session/refresh",
      });
      const rotated = sessionTokenSchema.safeParse(sessionTokenFromHeaders(response.headers));
      if (!rotated.success) throw contractError("The server did not rotate the session credential");
      stored.credential = { kind: "human", sessionToken: rotated.data };
      await saveProfileStore(directory, store);
      return { profile: name, refreshed: true };
    });
    writeResult(context.runtime.io, result, context.options.json);
    return;
  }

  if (subcommand === "logout") {
    requirePositionals(parseCommandArguments(args, {}), 0);
    const result = await withProfileLock(context.runtime, async (directory) => {
      const store = await loadProfileStore(directory);
      const name = validateProfileName(
        context.options.profile ?? context.runtime.env.HYPE_COMMS_PROFILE ?? store.defaultProfile,
      );
      const stored = store.profiles[name];
      if (stored === undefined)
        throw new UsageError(`Profile ${name} does not exist`, "PROFILE_NOT_FOUND");
      const profile = await resolveProfile(context.runtime, context.options, {
        ignoreEnvironmentToken: true,
      });
      if (stored.credential !== undefined && profile.credentialOrigin !== profile.apiOrigin) {
        throw new UsageError(
          "The saved credential belongs to a different API origin; logout from its saved profile origin",
          "CREDENTIAL_ORIGIN_MISMATCH",
        );
      }
      if (stored.credential?.kind === "human") {
        await new ApiClient({
          profile,
          fetch: context.runtime.fetch,
          timeoutMs: context.options.timeoutMs,
        }).requestEmpty({ method: "DELETE", path: "/v1/auth/session" });
      }
      delete stored.credential;
      delete stored.enrollmentOffer;
      await saveProfileStore(directory, store);
      return { profile: name, signedOut: true };
    });
    writeResult(context.runtime.io, result, context.options.json);
    return;
  }

  if (subcommand === "devices") {
    const [action, ...rest] = args;
    if (action === "list") {
      requirePositionals(parseCommandArguments(rest, {}), 0);
      const devices = await (
        await clientFromContext(context)
      ).request({
        path: "/v1/auth/devices",
        responseSchema: deviceSessionSchema.array(),
      });
      writeResult(context.runtime.io, devices, context.options.json);
      return;
    }
    if (action === "revoke") {
      const parsed = parseCommandArguments(rest, {});
      const [idValue] = requirePositionals(parsed, 1);
      const id = entityIdSchema.safeParse(idValue);
      if (!id.success) throw new UsageError("The device ID must be a UUID", "INVALID_DEVICE_ID");
      await (
        await clientFromContext(context)
      ).requestEmpty({
        method: "DELETE",
        path: `/v1/auth/devices/${id.data}`,
      });
      writeResult(context.runtime.io, { revoked: id.data }, context.options.json);
      return;
    }
    throw new UsageError("Usage: hype-comms-cli auth devices <list|revoke>");
  }

  throw new UsageError(
    "Usage: hype-comms-cli auth <request-magic-link|exchange|login-agent|whoami|refresh|logout|devices>",
  );
}
