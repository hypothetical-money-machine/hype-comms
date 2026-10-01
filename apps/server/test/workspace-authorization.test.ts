import { describe, expect, it } from "vitest";

import { conversationVisibilitySql } from "../src/modules/workspace/authorization.js";

describe("conversationVisibilitySql", () => {
  it("embeds the visibility tables and the supplied alias and user parameter", () => {
    const sql = conversationVisibilitySql("conversation", "$2");
    expect(sql).toContain("users AS visible_actor");
    expect(sql).toContain("conversation_memberships AS public_membership");
    expect(sql).toContain("conversation_memberships AS visible_membership");
    expect(sql).toContain("conversation_memberships AS group_membership");
    expect(sql).toContain("bot_channel_grants AS visible_bot_grant");
    expect(sql).toContain("conversation.kind = 'channel'");
    expect(sql).toContain("conversation.kind = 'group_direct_message'");
    expect(sql).toContain("visible_actor.id = $2");
    expect(conversationVisibilitySql("anchor", "$3")).toContain("anchor.kind = 'channel'");
  });
});
