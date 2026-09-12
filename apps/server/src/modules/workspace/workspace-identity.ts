import type { AuthenticatedIdentity } from "../identity/service.js";
import type { AuthenticatedBotIdentity } from "../bots/service.js";

export type AuthenticatedTaskIdentity = AuthenticatedIdentity | AuthenticatedBotIdentity;
