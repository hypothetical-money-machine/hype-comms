import {
  agentTokenScopeSchema,
  createAgentRequestSchema,
  createAgentResponseSchema,
  createAgentTokenRequestSchema,
  createAgentTokenResponseSchema,
  createInvitationSchema,
  entityIdSchema,
  invitationSchema,
  listAgentTokensResponseSchema,
  listAgentsResponseSchema,
  listInvitationsResponseSchema,
} from "@hmm-chat/contracts";

import {
  multipleOption,
  parseCommandArguments,
  requirePositionals,
  stringOption,
} from "../argv.js";
import type { ApiClient } from "../client.js";
import { clientFromContext } from "../context.js";
import { UsageError } from "../errors.js";
import { writeResult } from "../output.js";
import type { CommandContext } from "../types.js";

async function resolveAgent(client: ApiClient, selector: string): Promise<string> {
  const id = entityIdSchema.safeParse(selector);
  if (id.success) return id.data;
  const normalized = selector.replace(/^@/u, "").toLocaleLowerCase("en-US");
  const response = await client.request({
    path: "/v1/agents",
    responseSchema: listAgentsResponseSchema,
  });
  const matches = response.agents.filter(
    (agent) => agent.user.username.toLocaleLowerCase("en-US") === normalized,
  );
  if (matches.length === 0) throw new UsageError(`No agent matches ${selector}`, "AGENT_NOT_FOUND");
  if (matches.length > 1)
    throw new UsageError(`Agent selector ${selector} is ambiguous`, "AMBIGUOUS_AGENT");
  return matches[0]!.user.id;
}

export async function invitationsCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  const client = await clientFromContext(context);
  if (subcommand === "list") {
    requirePositionals(parseCommandArguments(args, {}), 0);
    const response = await client.request({
      path: "/v1/invitations",
      responseSchema: listInvitationsResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "create") {
    const parsed = parseCommandArguments(args, {});
    const [email] = requirePositionals(parsed, 1);
    const response = await client.request({
      method: "POST",
      path: "/v1/invitations",
      body: { email: email!, role: "member" as const },
      requestSchema: createInvitationSchema,
      responseSchema: invitationSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "revoke") {
    const parsed = parseCommandArguments(args, {});
    const [invitationValue] = requirePositionals(parsed, 1);
    const invitationId = entityIdSchema.safeParse(invitationValue);
    if (!invitationId.success) {
      throw new UsageError("The invitation ID must be a UUID", "INVALID_INVITATION_ID");
    }
    await client.requestEmpty({
      method: "DELETE",
      path: `/v1/invitations/${invitationId.data}`,
    });
    writeResult(context.runtime.io, { revoked: invitationId.data }, context.options.json);
    return;
  }
  throw new UsageError("Usage: hmm-chat-cli invitations <list|create|revoke>");
}

export async function agentsCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  const client = await clientFromContext(context);
  if (subcommand === "list") {
    requirePositionals(parseCommandArguments(args, {}), 0);
    const response = await client.request({
      path: "/v1/agents",
      responseSchema: listAgentsResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "create") {
    const parsed = parseCommandArguments(args, {
      "display-name": { kind: "string" },
    });
    const [username] = requirePositionals(parsed, 1);
    const displayName = stringOption(parsed, "display-name");
    if (displayName === undefined) throw new UsageError("agents create requires --display-name");
    const response = await client.request({
      method: "POST",
      path: "/v1/agents",
      body: { username: username!, displayName },
      requestSchema: createAgentRequestSchema,
      responseSchema: createAgentResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "disable") {
    const parsed = parseCommandArguments(args, {});
    const [selector] = requirePositionals(parsed, 1);
    const id = await resolveAgent(client, selector!);
    await client.requestEmpty({ method: "DELETE", path: `/v1/agents/${id}` });
    writeResult(context.runtime.io, { disabled: id }, context.options.json);
    return;
  }
  throw new UsageError("Usage: hmm-chat-cli agents <list|create|disable>");
}

export async function agentTokensCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  const client = await clientFromContext(context);
  if (subcommand === "list") {
    const parsed = parseCommandArguments(args, {});
    const [agentSelector] = requirePositionals(parsed, 1);
    const agentId = await resolveAgent(client, agentSelector!);
    const response = await client.request({
      path: `/v1/agents/${agentId}/tokens`,
      responseSchema: listAgentTokensResponseSchema,
    });
    writeResult(context.runtime.io, { agentId, ...response }, context.options.json);
    return;
  }
  if (subcommand === "create") {
    const parsed = parseCommandArguments(args, {
      label: { kind: "string" },
      scope: { kind: "string", multiple: true },
    });
    const [agentSelector] = requirePositionals(parsed, 1);
    const label = stringOption(parsed, "label");
    if (label === undefined) throw new UsageError("agent-tokens create requires --label");
    const scopes = multipleOption(parsed, "scope").map((value) => {
      const parsedScope = agentTokenScopeSchema.safeParse(value);
      if (!parsedScope.success) throw new UsageError(`Unsupported agent scope ${value}`);
      return parsedScope.data;
    });
    const agentId = await resolveAgent(client, agentSelector!);
    const body = {
      label,
      ...(scopes.length === 0 ? {} : { scopes }),
    };
    const response = await client.request({
      method: "POST",
      path: `/v1/agents/${agentId}/tokens`,
      body,
      requestSchema: createAgentTokenRequestSchema,
      responseSchema: createAgentTokenResponseSchema,
    });
    writeResult(context.runtime.io, { agentId, ...response }, context.options.json);
    return;
  }
  if (subcommand === "revoke") {
    const parsed = parseCommandArguments(args, {});
    const [agentSelector, tokenValue] = requirePositionals(parsed, 2);
    const tokenId = entityIdSchema.safeParse(tokenValue);
    if (!tokenId.success) throw new UsageError("The token ID must be a UUID", "INVALID_TOKEN_ID");
    const agentId = await resolveAgent(client, agentSelector!);
    await client.requestEmpty({
      method: "DELETE",
      path: `/v1/agents/${agentId}/tokens/${tokenId.data}`,
    });
    writeResult(context.runtime.io, { agentId, revoked: tokenId.data }, context.options.json);
    return;
  }
  throw new UsageError("Usage: hmm-chat-cli agent-tokens <list|create|revoke>");
}
