import { DomainError } from "../../domain-errors.js";

/** Compatibility failure; the HTTP boundary supplies the legacy envelope and header detail. */
export class GroupDirectClientUpgradeRequiredError extends DomainError {
  constructor() {
    super(
      "group_direct_client_upgrade_required",
      "Update Hype Comms to access this workspace because your account belongs to a group conversation",
    );
    this.name = "GroupDirectClientUpgradeRequiredError";
  }
}
