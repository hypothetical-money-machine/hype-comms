import type { User } from "@hype-comms/contracts";
import { describe, expect, it } from "vitest";

import {
  applyComposerFormat,
  composerFormatShortcut,
  composerFormatShortcutLabel,
  type ComposerFormatAction,
} from "./composer-formatting";
import { mentionedMemberIds } from "./mentions";

describe("applyComposerFormat inline styles", () => {
  it("wraps a selection in bold markers and keeps the words selected", () => {
    const result = applyComposerFormat("make it pop", 0, 4, "bold");
    expect(result).toEqual({ text: "**make** it pop", selectionStart: 2, selectionEnd: 6 });
  });

  it("unwraps when the selection includes the markers", () => {
    const result = applyComposerFormat("**make** it pop", 0, 8, "bold");
    expect(result).toEqual({ text: "make it pop", selectionStart: 0, selectionEnd: 4 });
  });

  it("unwraps when the markers sit just outside the selection", () => {
    const result = applyComposerFormat("**make** it pop", 2, 6, "bold");
    expect(result).toEqual({ text: "make it pop", selectionStart: 0, selectionEnd: 4 });
  });

  it("drops a caret between fresh markers when nothing is selected", () => {
    const result = applyComposerFormat("note ", 5, 5, "bold");
    expect(result).toEqual({ text: "note ****", selectionStart: 7, selectionEnd: 7 });
  });

  it("re-toggling an empty marker pair removes it", () => {
    const result = applyComposerFormat("note ****", 7, 7, "bold");
    expect(result).toEqual({ text: "note ", selectionStart: 5, selectionEnd: 5 });
  });

  it("uses single-asterisk italics so an italicized mention keeps its word boundary", () => {
    const result = applyComposerFormat("ping @alex now", 5, 10, "italic");
    expect(result).toEqual({ text: "ping *@alex* now", selectionStart: 6, selectionEnd: 11 });
  });

  it("italicizing inside bold nests the markers instead of eating bold's", () => {
    const result = applyComposerFormat("**word**", 2, 6, "italic");
    expect(result).toEqual({ text: "***word***", selectionStart: 3, selectionEnd: 7 });
  });

  it("unwraps a true italic pair around the selection", () => {
    const result = applyComposerFormat("see *word* now", 5, 9, "italic");
    expect(result).toEqual({ text: "see word now", selectionStart: 4, selectionEnd: 8 });
  });

  it("removes only the italic layer from bold italic text", () => {
    const result = applyComposerFormat("***word***", 3, 7, "italic");
    expect(result).toEqual({ text: "**word**", selectionStart: 2, selectionEnd: 6 });
  });

  it("removes only the bold layer from bold italic text", () => {
    const result = applyComposerFormat("***word***", 3, 7, "bold");
    expect(result).toEqual({ text: "*word*", selectionStart: 1, selectionEnd: 5 });
  });

  it("wraps strikethrough and inline code with their own markers", () => {
    expect(applyComposerFormat("old plan", 0, 8, "strikethrough").text).toBe("~~old plan~~");
    expect(applyComposerFormat("npm ci", 0, 6, "code").text).toBe("`npm ci`");
  });

  it("grows the code fence past embedded backticks", () => {
    const result = applyComposerFormat("run `npm ci` now", 0, 16, "code");
    expect(result.text).toBe("``run `npm ci` now``");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("run `npm ci` now");
  });

  it("unwraps a long-fenced selection back to its content", () => {
    const result = applyComposerFormat("``run `npm ci` now``", 0, 20, "code");
    expect(result).toEqual({ text: "run `npm ci` now", selectionStart: 0, selectionEnd: 16 });
  });

  it("pads the code fence when the selection itself edges on a backtick", () => {
    const result = applyComposerFormat("cmd`", 0, 4, "code");
    expect(result.text).toBe("`` cmd` ``");
    const roundTrip = applyComposerFormat(result.text, 0, result.text.length, "code");
    expect(roundTrip.text).toBe("cmd`");
  });

  it("unwraps a selection that includes its own single-backtick fences", () => {
    expect(applyComposerFormat("`cmd`", 0, 5, "code")).toEqual({
      text: "cmd",
      selectionStart: 0,
      selectionEnd: 3,
    });
  });

  it("wraps a selection between two code spans instead of consuming their fences", () => {
    const result = applyComposerFormat("`a` b `c`", 4, 5, "code");
    expect(result).toEqual({ text: "`a` `b` `c`", selectionStart: 5, selectionEnd: 6 });
  });

  it("leaves tightly packed neighboring spans alone when formatting between them", () => {
    const result = applyComposerFormat("`a`b`c`", 3, 4, "code");
    expect(result.text).toBe("`a``b``c`");
  });

  it("wraps between spans of non-word content instead of consuming their fences", () => {
    const result = applyComposerFormat("` `b` `", 3, 4, "code");
    expect(result.text).toBe("` ``b`` `");
  });

  it("unwraps the whole span when the selection covers part of its content", () => {
    const result = applyComposerFormat("see `npm ci` now", 5, 8, "code");
    expect(result).toEqual({ text: "see npm ci now", selectionStart: 4, selectionEnd: 10 });
  });

  it("removes an empty fence pair at the caret", () => {
    const result = applyComposerFormat("note ``", 6, 6, "code");
    expect(result).toEqual({ text: "note ", selectionStart: 5, selectionEnd: 5 });
  });

  it("unwraps the span when the caret splits a backtick run inside its content", () => {
    const result = applyComposerFormat("`a``b`", 3, 3, "code");
    expect(result).toEqual({ text: "a``b", selectionStart: 0, selectionEnd: 4 });
  });

  it("round-trips the padded fence from the selection it returns", () => {
    const wrapped = applyComposerFormat("cmd`", 0, 4, "code");
    const unwrapped = applyComposerFormat(
      wrapped.text,
      wrapped.selectionStart,
      wrapped.selectionEnd,
      "code",
    );
    expect(unwrapped).toEqual({ text: "cmd`", selectionStart: 0, selectionEnd: 4 });
  });

  it("swaps selection bounds passed in reverse order", () => {
    const result = applyComposerFormat("make it pop", 4, 0, "bold");
    expect(result.text).toBe("**make** it pop");
  });

  it("clamps out-of-range selection offsets", () => {
    const result = applyComposerFormat("hi", -3, 99, "bold");
    expect(result).toEqual({ text: "**hi**", selectionStart: 2, selectionEnd: 4 });
  });
});

describe("applyComposerFormat links", () => {
  it("keeps selected text as the label and selects the url placeholder", () => {
    const result = applyComposerFormat("see the docs now", 8, 12, "link");
    expect(result.text).toBe("see the [docs](url) now");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("url");
  });

  it("keeps a selected https url as the destination and selects the label placeholder", () => {
    const result = applyComposerFormat("https://example.com", 0, 19, "link");
    expect(result.text).toBe("[link text](https://example.com)");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("link text");
  });

  it("inserts a full placeholder link at a bare caret", () => {
    const result = applyComposerFormat("", 0, 0, "link");
    expect(result.text).toBe("[link text](url)");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("link text");
  });

  it("escapes Markdown delimiters in a selected label", () => {
    const result = applyComposerFormat("see docs] here", 4, 9, "link");
    expect(result.text).toBe("see [docs\\]](url) here");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("url");
  });

  it("treats an http url as a label because the renderer links https only", () => {
    const result = applyComposerFormat("http://example.com", 0, 18, "link");
    expect(result.text).toBe("[http://example.com](url)");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("url");
  });

  it("treats a credential-bearing url as a label because the renderer rejects it", () => {
    const result = applyComposerFormat("https://user:secret@example.com", 0, 31, "link");
    expect(result.text).toBe("[https://user:secret@example.com](url)");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("url");
  });

  it("escapes parentheses in a selected https destination", () => {
    const result = applyComposerFormat("https://x.dev/a(b)", 0, 18, "link");
    expect(result.text).toBe("[link text](https://x.dev/a\\(b\\))");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("link text");
  });

  it("escapes angle brackets in a selected https destination", () => {
    const result = applyComposerFormat("https://x.dev/a<b>", 0, 18, "link");
    expect(result.text).toBe("[link text](https://x.dev/a\\<b\\>)");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("link text");
  });
});

describe("applyComposerFormat line styles", () => {
  it("prefixes every selected line as a bulleted list and selects the block", () => {
    const result = applyComposerFormat("one\ntwo\nthree", 0, 13, "bulleted-list");
    expect(result.text).toBe("- one\n- two\n- three");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe(result.text);
  });

  it("removes bullets when every selected line already has one", () => {
    const result = applyComposerFormat("- one\n- two", 0, 11, "bulleted-list");
    expect(result.text).toBe("one\ntwo");
  });

  it("numbers non-empty lines in order and skips blank separators", () => {
    const result = applyComposerFormat("one\n\ntwo", 0, 8, "numbered-list");
    expect(result.text).toBe("1. one\n\n2. two");
  });

  it("strips numbered prefixes of any width when toggling off", () => {
    const result = applyComposerFormat("1. one\n12. two", 0, 14, "numbered-list");
    expect(result.text).toBe("one\ntwo");
  });

  it("expands a caret to its whole line and moves the caret past the prefix", () => {
    const result = applyComposerFormat("first\nsecond", 8, 8, "quote");
    expect(result).toEqual({ text: "first\n> second", selectionStart: 10, selectionEnd: 10 });
  });

  it("toggles a quote off from a caret inside the line", () => {
    const result = applyComposerFormat("> second", 5, 5, "quote");
    expect(result).toEqual({ text: "second", selectionStart: 3, selectionEnd: 3 });
  });

  it("starts a list on an empty line", () => {
    const result = applyComposerFormat("", 0, 0, "bulleted-list");
    expect(result).toEqual({ text: "- ", selectionStart: 2, selectionEnd: 2 });
  });

  it("ignores the trailing line when the selection ends on its first character boundary", () => {
    const text = "one\ntwo\nthree";
    const result = applyComposerFormat(text, 0, 8, "bulleted-list");
    expect(result.text).toBe("- one\n- two\nthree");
  });

  it("formats a mixed selection without double-prefixing the already-formatted lines", () => {
    const result = applyComposerFormat("- one\ntwo", 0, 9, "bulleted-list");
    expect(result.text).toBe("- one\n- two");
  });

  it("renumbers stale ordinals when a mixed selection becomes a numbered list", () => {
    const result = applyComposerFormat("7. one\ntwo", 0, 10, "numbered-list");
    expect(result.text).toBe("1. one\n2. two");
  });
});

describe("applyComposerFormat mention preservation", () => {
  const alex: User = {
    id: "10000000-0000-4000-8000-000000000002",
    kind: "human",
    username: "alex",
    displayName: "Alex Rivera",
    avatarUrl: null,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  };

  it("expands username-only formatting over the whole mention and keeps it detectable", () => {
    const result = applyComposerFormat("ping @alex now", 6, 10, "italic");
    expect(result).toEqual({ text: "ping *@alex* now", selectionStart: 6, selectionEnd: 11 });
    expect(mentionedMemberIds(result.text, [alex], [alex.id])).toEqual([alex.id]);
  });

  it("expands a mid-username selection the same way", () => {
    const result = applyComposerFormat("ping @alex now", 7, 9, "bold");
    expect(result.text).toBe("ping **@alex** now");
    expect(mentionedMemberIds(result.text, [alex], [alex.id])).toEqual([alex.id]);
  });

  it("expands code formatting over the whole mention", () => {
    const result = applyComposerFormat("@alex", 1, 5, "code");
    expect(result.text).toBe("`@alex`");
    expect(mentionedMemberIds(result.text, [alex], [alex.id])).toEqual([alex.id]);
  });

  it("does not expand across word-glued addresses", () => {
    const result = applyComposerFormat("mail hello@example now", 11, 18, "italic");
    expect(result.text).toBe("mail hello@*example* now");
  });

  it("does not steal a neighboring emphasis marker when toggling italic beside one", () => {
    const result = applyComposerFormat("*foo*@alex*", 5, 10, "italic");
    expect(result.text).toBe("*foo**@alex**");
    expect(mentionedMemberIds(result.text, [alex], [alex.id])).toEqual([alex.id]);
  });

  it("does not drag a mention into the wrap when the selection starts at its end", () => {
    const result = applyComposerFormat("@alex*foo*", 5, 10, "italic");
    expect(result.text).toBe("@alex**foo**");
    expect(mentionedMemberIds(result.text, [alex], [alex.id])).toEqual([alex.id]);
  });

  it("does not strip a neighboring marker when the selection includes glued asterisks", () => {
    const result = applyComposerFormat("*foo*@alex*", 4, 11, "italic");
    expect(result.text).toBe("*foo**@alex**");
    expect(mentionedMemberIds(result.text, [alex], [alex.id])).toEqual([alex.id]);
  });
});

describe("composerFormatShortcut", () => {
  const base = {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };

  it.each([
    ["b", "bold"],
    ["i", "italic"],
    ["e", "code"],
  ] as const)("maps the platform modifier + %s", (key, action) => {
    expect(composerFormatShortcut({ ...base, key, ctrlKey: true }, "linux")).toBe(action);
    expect(composerFormatShortcut({ ...base, key, ctrlKey: true }, "win32")).toBe(action);
    expect(
      composerFormatShortcut({ ...base, key: key.toUpperCase(), metaKey: true }, "darwin"),
    ).toBe(action);
  });

  it.each([
    ["x", "", "strikethrough"],
    ["k", "", "link"],
    ["&", "Digit7", "numbered-list"],
    ["*", "Digit8", "bulleted-list"],
    ["(", "Digit9", "quote"],
  ] as const)("maps Mod+Shift+%s", (key, code, action) => {
    expect(
      composerFormatShortcut({ ...base, key, code, ctrlKey: true, shiftKey: true }, "linux"),
    ).toBe(action);
    expect(
      composerFormatShortcut({ ...base, key, code, metaKey: true, shiftKey: true }, "darwin"),
    ).toBe(action);
  });

  it("keeps macOS native Ctrl text-navigation bindings out of formatting", () => {
    expect(composerFormatShortcut({ ...base, key: "b", ctrlKey: true }, "darwin")).toBeNull();
    expect(composerFormatShortcut({ ...base, key: "e", ctrlKey: true }, "darwin")).toBeNull();
    expect(
      composerFormatShortcut({ ...base, key: "b", ctrlKey: true, metaKey: true }, "darwin"),
    ).toBeNull();
  });

  it("ignores Meta combinations on platforms that advertise Ctrl", () => {
    expect(composerFormatShortcut({ ...base, key: "b", metaKey: true }, "linux")).toBeNull();
    expect(composerFormatShortcut({ ...base, key: "b", metaKey: true }, "win32")).toBeNull();
    expect(
      composerFormatShortcut({ ...base, key: "b", ctrlKey: true, metaKey: true }, "linux"),
    ).toBeNull();
  });

  it("leaves send, quick-switcher, and compact-mode shortcuts alone", () => {
    expect(composerFormatShortcut({ ...base, key: "Enter" }, "linux")).toBeNull();
    expect(composerFormatShortcut({ ...base, key: "Enter", ctrlKey: true }, "linux")).toBeNull();
    expect(composerFormatShortcut({ ...base, key: "k", ctrlKey: true }, "linux")).toBeNull();
    expect(
      composerFormatShortcut({ ...base, key: "s", ctrlKey: true, shiftKey: true }, "linux"),
    ).toBeNull();
    expect(composerFormatShortcut({ ...base, key: "b" }, "linux")).toBeNull();
    expect(
      composerFormatShortcut({ ...base, key: "b", ctrlKey: true, altKey: true }, "linux"),
    ).toBeNull();
  });

  it("labels every action for both platforms", () => {
    const actions: readonly ComposerFormatAction[] = [
      "bold",
      "italic",
      "strikethrough",
      "code",
      "link",
      "bulleted-list",
      "numbered-list",
      "quote",
    ];
    for (const action of actions) {
      expect(composerFormatShortcutLabel(action, "darwin")).toMatch(/^Cmd\+/);
      expect(composerFormatShortcutLabel(action, "linux")).toMatch(/^Ctrl\+/);
    }
    expect(composerFormatShortcutLabel("strikethrough", "linux")).toBe("Ctrl+Shift+X");
    expect(composerFormatShortcutLabel("link", "darwin")).toBe("Cmd+Shift+K");
  });
});
