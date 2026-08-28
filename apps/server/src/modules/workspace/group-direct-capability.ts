import { ApiError } from "../../errors.js";

/**
 * The fixed previous desktop understands the error envelope and will surface this message, but it
 * cannot safely identify every recipient in a group. Keep the existing CONFLICT code so that
 * client can validate the response while making the required action explicit.
 */
export class GroupDirectClientUpgradeRequiredError extends ApiError {
  constructor() {
    super(
      409,
      "CONFLICT",
      "Update Hype Comms to access this workspace because your account belongs to a group conversation",
      [
        {
          field: "X-Hype-Comms-Capabilities",
          issue: "group-direct-messages-v1 is required",
        },
      ],
    );
    this.name = "GroupDirectClientUpgradeRequiredError";
  }
}
