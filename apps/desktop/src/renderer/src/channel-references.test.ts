import { describe, expect, it } from "vitest";

import { segmentMessageBody, type ChannelReferenceTarget } from "./channel-references";

const GENERAL_ID = "10000000-0000-4000-8000-000000000001";
const DEV_OPS_ID = "10000000-0000-4000-8000-000000000002";
const CAFE_ID = "10000000-0000-4000-8000-000000000003";

const channels: ChannelReferenceTarget[] = [
  { conversationId: GENERAL_ID, slug: "general" },
  { conversationId: DEV_OPS_ID, slug: "dev-ops" },
  { conversationId: CAFE_ID, slug: "café" },
];

describe("segmentMessageBody", () => {
  it("links a known channel slug and keeps surrounding text", () => {
    expect(segmentMessageBody("see #general for updates", channels)).toEqual([
      { kind: "text", text: "see " },
      { kind: "channel", text: "#general", conversationId: GENERAL_ID },
      { kind: "text", text: " for updates" },
    ]);
  });

  it("returns one text segment when nothing matches", () => {
    expect(segmentMessageBody("no references here", channels)).toEqual([
      { kind: "text", text: "no references here" },
    ]);
    expect(segmentMessageBody("#unknown-channel", channels)).toEqual([
      { kind: "text", text: "#unknown-channel" },
    ]);
  });

  it("links multiple references in one body", () => {
    expect(segmentMessageBody("#general then #dev-ops", channels)).toEqual([
      { kind: "channel", text: "#general", conversationId: GENERAL_ID },
      { kind: "text", text: " then " },
      { kind: "channel", text: "#dev-ops", conversationId: DEV_OPS_ID },
    ]);
  });

  it("resolves display casing to the lowercase slug while keeping the typed text", () => {
    expect(segmentMessageBody("#General", channels)).toEqual([
      { kind: "channel", text: "#General", conversationId: GENERAL_ID },
    ]);
  });

  it("matches Unicode slugs across NFKC normalization forms", () => {
    const decomposed = "#café";
    expect(segmentMessageBody(decomposed, channels)).toEqual([
      { kind: "channel", text: decomposed, conversationId: CAFE_ID },
    ]);
  });

  it("keeps trailing punctuation and hyphens outside the reference", () => {
    expect(segmentMessageBody("try #general.", channels)).toEqual([
      { kind: "text", text: "try " },
      { kind: "channel", text: "#general", conversationId: GENERAL_ID },
      { kind: "text", text: "." },
    ]);
    expect(segmentMessageBody("try #general- now", channels)).toEqual([
      { kind: "text", text: "try " },
      { kind: "channel", text: "#general", conversationId: GENERAL_ID },
      { kind: "text", text: "- now" },
    ]);
  });

  it("never links a slug that is only a prefix of what the author typed", () => {
    expect(segmentMessageBody("#general-updates", channels)).toEqual([
      { kind: "text", text: "#general-updates" },
    ]);
  });

  it("never links a prefix of an underscore- or hash-glued candidate", () => {
    expect(segmentMessageBody("#general_team", channels)).toEqual([
      { kind: "text", text: "#general_team" },
    ]);
    expect(segmentMessageBody("#general#ops", channels)).toEqual([
      { kind: "text", text: "#general#ops" },
    ]);
  });

  it("treats NFKC hyphen variants as part of the candidate, never a prefix boundary", () => {
    // U+FF0D FULLWIDTH HYPHEN-MINUS and U+FE63 SMALL HYPHEN-MINUS both normalize to "-".
    expect(segmentMessageBody("ship #general－ops today", channels)).toEqual([
      { kind: "text", text: "ship #general－ops today" },
    ]);
    expect(segmentMessageBody("#dev﹣ops", channels)).toEqual([
      { kind: "channel", text: "#dev﹣ops", conversationId: DEV_OPS_ID },
    ]);
    expect(segmentMessageBody("see #general－ now", channels)).toEqual([
      { kind: "text", text: "see " },
      { kind: "channel", text: "#general", conversationId: GENERAL_ID },
      { kind: "text", text: "－ now" },
    ]);
  });

  it("never links a prefix of a candidate glued to NFKC underscore or hash variants", () => {
    // U+FF3F FULLWIDTH LOW LINE and U+FF03 FULLWIDTH NUMBER SIGN normalize to "_" and "#".
    expect(segmentMessageBody("#general＿team", channels)).toEqual([
      { kind: "text", text: "#general＿team" },
    ]);
    expect(segmentMessageBody("#general＃ops", channels)).toEqual([
      { kind: "text", text: "#general＃ops" },
    ]);
  });

  it("never links a prefix glued to an NFKC compatibility symbol", () => {
    // U+24D0 CIRCLED LATIN SMALL LETTER A and U+338F SQUARE KG normalize to "a" and "kg".
    expect(segmentMessageBody("#generalⓐ", channels)).toEqual([
      { kind: "text", text: "#generalⓐ" },
    ]);
    expect(segmentMessageBody("#general㎏", channels)).toEqual([
      { kind: "text", text: "#general㎏" },
    ]);
    expect(segmentMessageBody("ⓐ#general", channels)).toEqual([
      { kind: "text", text: "ⓐ#general" },
    ]);
  });

  it("matches slugs supplied in a non-NFKC or uppercase form", () => {
    const decomposedSlug = "café".normalize("NFD");
    expect(
      segmentMessageBody("#café", [{ conversationId: CAFE_ID, slug: decomposedSlug }]),
    ).toEqual([{ kind: "channel", text: "#café", conversationId: CAFE_ID }]);
    expect(
      segmentMessageBody("#general", [{ conversationId: GENERAL_ID, slug: "General" }]),
    ).toEqual([{ kind: "channel", text: "#general", conversationId: GENERAL_ID }]);
  });

  it("ignores hashes glued to a preceding word or doubled", () => {
    expect(segmentMessageBody("issue#general", channels)).toEqual([
      { kind: "text", text: "issue#general" },
    ]);
    expect(segmentMessageBody("##general", channels)).toEqual([
      { kind: "text", text: "##general" },
    ]);
  });

  it("links a reference after ordinary punctuation", () => {
    expect(segmentMessageBody("(#general)", channels)).toEqual([
      { kind: "text", text: "(" },
      { kind: "channel", text: "#general", conversationId: GENERAL_ID },
      { kind: "text", text: ")" },
    ]);
  });

  it("returns the body untouched when no channels are visible", () => {
    expect(segmentMessageBody("#general", [])).toEqual([{ kind: "text", text: "#general" }]);
  });

  it("never links a built-in channel, whose slug is outside the reference grammar", () => {
    const builtIn = [{ conversationId: GENERAL_ID, slug: "hype/release-notes" }];
    expect(segmentMessageBody("#hype/release-notes", builtIn)).toEqual([
      { kind: "text", text: "#hype/release-notes" },
    ]);
    expect(segmentMessageBody("#hype", builtIn)).toEqual([{ kind: "text", text: "#hype" }]);
  });
});
