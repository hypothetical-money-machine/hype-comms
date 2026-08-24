import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  AGENT_ENROLLMENT_AUTHORIZATION_SCHEME,
  agentEnrollmentCredentialVerifierSchema,
  agentEnrollmentPolicyModeSchema,
  agentEnrollmentPolicyResponseSchema,
  agentEnrollmentResponseSchema,
  agentTokenSecretSchema,
  currentPrincipalSchema,
  entityIdSchema,
  idempotencyKeySchema,
  listAgentEnrollmentsResponseSchema,
  redeemAgentEnrollmentResponseSchema,
  requestAgentEnrollmentSchema,
  reviewAgentEnrollmentRequestSchema,
  updateAgentEnrollmentPolicyRequestSchema,
} from "@hype-comms/contracts";

import {
  booleanOption,
  multipleOption,
  parseCommandArguments,
  requirePositionals,
  stringOption,
} from "../argv.js";
import { ApiClient } from "../client.js";
import {
  loadProfileStore,
  normalizeApiOrigin,
  resolveProfile,
  resolveProfileSnapshot,
  updateProfileStore,
} from "../config.js";
import { clientFromContext } from "../context.js";
import { UsageError, contractError } from "../errors.js";
import { writeResult } from "../output.js";
import type { CommandContext } from "../types.js";

function validEnrollmentRequest(value: unknown) {
  const parsed = requestAgentEnrollmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new UsageError("The enrollment request is invalid", "INVALID_ENROLLMENT_REQUEST");
  }
  return parsed.data;
}

function enrollmentId(value: string): string {
  const parsed = entityIdSchema.safeParse(value);
  if (!parsed.success) throw new UsageError("The enrollment ID must be a UUID", "INVALID_ID");
  return parsed.data;
}

function restrictedChannelIds(values: readonly string[]): readonly string[] {
  const ids = values.map((value) => {
    const parsed = entityIdSchema.safeParse(value);
    if (!parsed.success) {
      throw new UsageError("Restricted channel IDs must be UUIDs", "INVALID_CHANNEL_ID");
    }
    return parsed.data;
  });
  if (new Set(ids).size !== ids.length) {
    throw new UsageError("Restricted channel IDs must be unique", "DUPLICATE_CHANNEL_ID");
  }
  return ids;
}

function requiredOption(parsed: ReturnType<typeof parseCommandArguments>, name: string): string {
  const value = stringOption(parsed, name);
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
}

export function generateEnrollmentCandidate(): {
  readonly token: string;
  readonly credentialVerifier: string;
} {
  const token = agentTokenSecretSchema.parse(
    `hype_comms_agent_${randomBytes(32).toString("base64url")}`,
  );
  const credentialVerifier = agentEnrollmentCredentialVerifierSchema.parse(
    createHash("sha256").update(token, "utf8").digest("base64url"),
  );
  return { token, credentialVerifier };
}

function enrollmentRequestArguments(parsed: ReturnType<typeof parseCommandArguments>): {
  readonly username: string;
  readonly displayName: string;
  readonly label: string;
  readonly restrictedChannelIds: readonly string[];
} {
  const [username] = requirePositionals(parsed, 1);
  return {
    username: username!,
    displayName: requiredOption(parsed, "display-name"),
    label: requiredOption(parsed, "label"),
    restrictedChannelIds: restrictedChannelIds(multipleOption(parsed, "restricted-channel-id")),
  };
}

function writeOffer(
  context: CommandContext,
  profile: string,
  apiOrigin: string,
  request: ReturnType<typeof validEnrollmentRequest>,
): void {
  writeResult(context.runtime.io, { profile, apiOrigin, request }, context.options.json);
}

async function offer(context: CommandContext, args: readonly string[]): Promise<void> {
  const parsed = parseCommandArguments(args, {
    "display-name": { kind: "string" },
    label: { kind: "string" },
    "restricted-channel-id": { kind: "string", multiple: true },
    resume: { kind: "boolean" },
  });
  const profile = await resolveProfile(context.runtime, context.options, {
    ignoreEnvironmentToken: true,
  });
  if (booleanOption(parsed, "resume")) {
    requirePositionals(parsed, 0);
    if (
      stringOption(parsed, "display-name") !== undefined ||
      stringOption(parsed, "label") !== undefined ||
      multipleOption(parsed, "restricted-channel-id").length > 0
    ) {
      throw new UsageError("--resume does not accept new enrollment fields");
    }
    const stored = (await loadProfileStore(profile.configDirectory)).profiles[profile.name];
    if (stored?.credential?.kind !== "agent" || stored.enrollmentOffer === undefined) {
      throw new UsageError(
        "The selected child profile has no pending enrollment offer",
        "ENROLLMENT_OFFER_NOT_FOUND",
      );
    }
    if (profile.credentialOrigin !== profile.apiOrigin) {
      throw new UsageError(
        "The saved enrollment offer belongs to a different API origin",
        "CREDENTIAL_ORIGIN_MISMATCH",
      );
    }
    writeOffer(context, profile.name, profile.apiOrigin, stored.enrollmentOffer.request);
    return;
  }

  const request = enrollmentRequestArguments(parsed);
  if (profile.credential !== undefined) {
    throw new UsageError(
      "The selected child profile already contains a credential",
      "PROFILE_HAS_CREDENTIAL",
    );
  }
  const candidate = generateEnrollmentCandidate();
  const body = validEnrollmentRequest({
    username: request.username,
    displayName: request.displayName,
    label: request.label,
    credentialVerifier: candidate.credentialVerifier,
    restrictedChannelIds: request.restrictedChannelIds,
  });
  // Persist before exposing the verifier. If output delivery is interrupted, the final candidate
  // is still recoverable by the child and can safely be redeemed after the request is submitted.
  await updateProfileStore(context.runtime, (store) => {
    if (store.profiles[profile.name]?.credential !== undefined) {
      throw new UsageError(
        "The selected child profile already contains a credential",
        "PROFILE_HAS_CREDENTIAL",
      );
    }
    store.profiles[profile.name] = {
      apiOrigin: profile.apiOrigin,
      credential: { kind: "agent", token: candidate.token },
      enrollmentOffer: { request: body },
    };
  });
  writeOffer(context, profile.name, profile.apiOrigin, body);
}

async function requestEnrollment(context: CommandContext, args: readonly string[]): Promise<void> {
  const parsed = parseCommandArguments(args, {
    "display-name": { kind: "string" },
    label: { kind: "string" },
    "credential-verifier": { kind: "string" },
    "restricted-channel-id": { kind: "string", multiple: true },
    "idempotency-key": { kind: "string" },
  });
  const request = enrollmentRequestArguments(parsed);
  const verifierValue = requiredOption(parsed, "credential-verifier");
  const credentialVerifier = agentEnrollmentCredentialVerifierSchema.safeParse(verifierValue);
  if (!credentialVerifier.success) {
    throw new UsageError("--credential-verifier is invalid", "INVALID_VERIFIER");
  }
  const explicitKey = stringOption(parsed, "idempotency-key");
  const idempotencyKey = idempotencyKeySchema.safeParse(
    explicitKey ?? `agent-enrollment:${credentialVerifier.data}`,
  );
  if (!idempotencyKey.success) {
    throw new UsageError("--idempotency-key is invalid", "INVALID_IDEMPOTENCY_KEY");
  }
  const body = validEnrollmentRequest({
    username: request.username,
    displayName: request.displayName,
    label: request.label,
    credentialVerifier: credentialVerifier.data,
    restrictedChannelIds: request.restrictedChannelIds,
  });
  const response = await (
    await clientFromContext(context)
  ).request({
    method: "POST",
    path: "/v1/agent-enrollments",
    body,
    requestSchema: requestAgentEnrollmentSchema,
    responseSchema: agentEnrollmentResponseSchema,
    headers: { "idempotency-key": idempotencyKey.data },
  });
  writeResult(
    context.runtime.io,
    { ...response, idempotencyKey: idempotencyKey.data },
    context.options.json,
  );
}

async function redeem(context: CommandContext, args: readonly string[]): Promise<void> {
  const parsed = parseCommandArguments(args, {});
  const [value] = requirePositionals(parsed, 1);
  const id = enrollmentId(value!);
  const snapshot = await resolveProfileSnapshot(context.runtime, context.options, {
    ignoreEnvironmentToken: true,
  });
  const { profile, storedProfile: stored } = snapshot;
  if (stored?.credential?.kind !== "agent" || stored.enrollmentOffer === undefined) {
    throw new UsageError(
      "The selected child profile has no locally generated enrollment credential",
      "ENROLLMENT_CREDENTIAL_REQUIRED",
    );
  }
  if (
    profile.credentialOrigin !== profile.apiOrigin ||
    normalizeApiOrigin(stored.apiOrigin) !== profile.apiOrigin
  ) {
    throw new UsageError(
      "The saved enrollment offer belongs to a different API origin",
      "CREDENTIAL_ORIGIN_MISMATCH",
    );
  }
  const token = stored.credential.token;
  const unauthenticated = new ApiClient({
    profile: {
      name: profile.name,
      apiOrigin: profile.apiOrigin,
      credentialFromEnvironment: false,
      configDirectory: profile.configDirectory,
    },
    fetch: context.runtime.fetch,
    timeoutMs: context.options.timeoutMs,
  });
  const redeemed = await unauthenticated.request({
    method: "POST",
    path: `/v1/agent-enrollments/${id}/redeem`,
    responseSchema: redeemAgentEnrollmentResponseSchema,
    includeCredential: false,
    headers: { authorization: `${AGENT_ENROLLMENT_AUTHORIZATION_SCHEME} ${token}` },
  });

  const activeClient = new ApiClient({
    profile: {
      ...profile,
      credential: { kind: "agent", token },
      credentialOrigin: profile.apiOrigin,
      credentialFromEnvironment: false,
    },
    fetch: context.runtime.fetch,
    timeoutMs: context.options.timeoutMs,
  });
  const principal = await activeClient.request({
    path: "/v1/auth/me",
    responseSchema: currentPrincipalSchema,
  });
  if (!("type" in principal) || principal.type !== "agent") {
    throw contractError("The redeemed credential did not authenticate an agent");
  }
  if (principal.user.id !== redeemed.agent.user.id) {
    throw contractError("The redeemed credential authenticated the wrong agent");
  }
  // The candidate already resides in the private profile. Clear its one-time offer only if no
  // concurrent command changed that exact profile while the server calls were in flight.
  await updateProfileStore(context.runtime, (store) => {
    const current = store.profiles[profile.name];
    if (current === undefined || !isDeepStrictEqual(current, stored)) {
      throw new UsageError(
        "The child profile changed during redemption; its newer state was preserved",
        "ENROLLMENT_PROFILE_CHANGED",
      );
    }
    delete current.enrollmentOffer;
  });
  writeResult(
    context.runtime.io,
    {
      enrollment: redeemed.enrollment,
      agent: redeemed.agent,
      principal,
      profile: profile.name,
      saved: true,
    },
    context.options.json,
  );
}

export async function agentEnrollmentsCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  if (subcommand === "offer") {
    await offer(context, args);
    return;
  }
  if (subcommand === "request") {
    await requestEnrollment(context, args);
    return;
  }
  if (subcommand === "redeem") {
    await redeem(context, args);
    return;
  }

  const client = await clientFromContext(context);
  if (subcommand === "status") {
    const parsed = parseCommandArguments(args, {});
    const [value] = requirePositionals(parsed, 1);
    const response = await client.request({
      path: `/v1/agent-enrollments/${enrollmentId(value!)}`,
      responseSchema: agentEnrollmentResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "cancel") {
    const parsed = parseCommandArguments(args, {});
    const [value] = requirePositionals(parsed, 1);
    const response = await client.request({
      method: "POST",
      path: `/v1/agent-enrollments/${enrollmentId(value!)}/cancel`,
      responseSchema: agentEnrollmentResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "list") {
    requirePositionals(parseCommandArguments(args, {}), 0);
    const response = await client.request({
      path: "/v1/agent-enrollments",
      responseSchema: listAgentEnrollmentsResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "approve" || subcommand === "reject") {
    const parsed = parseCommandArguments(args, {});
    const [value] = requirePositionals(parsed, 1);
    const body = { decision: subcommand } as const;
    const response = await client.request({
      method: "POST",
      path: `/v1/agent-enrollments/${enrollmentId(value!)}/review`,
      body,
      requestSchema: reviewAgentEnrollmentRequestSchema,
      responseSchema: agentEnrollmentResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  throw new UsageError(
    "Usage: hype-comms-cli agent-enrollments <offer|request|status|cancel|list|approve|reject|redeem>",
  );
}

export async function agentEnrollmentPolicyCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  const client = await clientFromContext(context);
  if (subcommand === "show") {
    requirePositionals(parseCommandArguments(args, {}), 0);
    const response = await client.request({
      path: "/v1/agent-enrollment-policy",
      responseSchema: agentEnrollmentPolicyResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "set") {
    const parsed = parseCommandArguments(args, {});
    const [value] = requirePositionals(parsed, 1);
    const mode = agentEnrollmentPolicyModeSchema.safeParse(value);
    if (!mode.success) {
      throw new UsageError("Policy mode must be required or automatic", "INVALID_POLICY_MODE");
    }
    const body = { mode: mode.data };
    const response = await client.request({
      method: "PATCH",
      path: "/v1/agent-enrollment-policy",
      body,
      requestSchema: updateAgentEnrollmentPolicyRequestSchema,
      responseSchema: agentEnrollmentPolicyResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  throw new UsageError("Usage: hype-comms-cli agent-enrollment-policy <show|set>");
}
