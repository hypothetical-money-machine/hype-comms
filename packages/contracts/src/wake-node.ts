/// <reference types="node" />

import { createHash } from "node:crypto";

import { encodeAgentWakeKeyInput, getAgentWakeKeyInput } from "./wake.js";
import type { AgentWakeCandidate, AgentWakeId } from "./wake.js";

/** Node-only SHA-256 derivation for the canonical logical wake key. */
export function deriveAgentWakeId(
  candidate: Pick<AgentWakeCandidate, "workspaceId" | "agentUserId" | "messageId">,
): AgentWakeId {
  return createHash("sha256")
    .update(encodeAgentWakeKeyInput(getAgentWakeKeyInput(candidate)), "utf8")
    .digest("hex");
}
