import { SYSTEM_USER_ID, type SYSTEM_CHANNEL_SLUG_PREFIX } from "@hype-comms/contracts";

import { loadReleaseNoteBulletins, type SystemBulletin } from "./release-notes.js";

/**
 * The publisher of every server-authored bulletin, created in migration 0031. A bot principal
 * keeps it out of the human-owner authorization paths while giving each bulletin a real, auditable
 * author. The id lives in contracts because clients match it to attribute bulletins.
 */
export { SYSTEM_USER_ID };
export const SYSTEM_USER_DISPLAY_NAME = "Hype Comms";

export interface BuiltInChannelDefinition {
  /** Always inside the reserved namespace, so it can never collide with a member's channel. */
  readonly slug: `${typeof SYSTEM_CHANNEL_SLUG_PREFIX}${string}`;
  readonly name: string;
  readonly topic: string;
  readonly loadBulletins: () => Promise<readonly SystemBulletin[]>;
}

/** Every built-in channel the server seeds. Adding one is a new entry, not new seeding code. */
export const BUILT_IN_CHANNELS: readonly BuiltInChannelDefinition[] = [
  {
    slug: "hype/release-notes",
    name: "Release notes",
    topic: "What changed in each Hype Comms release, posted by the app.",
    loadBulletins: loadReleaseNoteBulletins,
  },
];
