// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { User } from "@hype-comms/contracts";

import { FencedBlockquoteProvider } from "./fenced-blockquote-context";
import { FencedBlockquoteRuntime } from "./fenced-blockquote-runtime";
import { MessageBody } from "./message-body";

const GENERAL_ID = "10000000-0000-4000-8000-000000000001";

const ALEX_ID = "10000000-0000-4000-8000-000000000011";

const channels = [{ conversationId: GENERAL_ID, slug: "general" }];

const alex: User = {
  id: ALEX_ID,
  kind: "human",
  username: "alex",
  displayName: "Alex Rivera",
  avatarUrl: null,
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
};

afterEach(cleanup);

describe("MessageBody", () => {
  it("renders channel references as buttons that open the channel", () => {
    const onOpenChannel = vi.fn();
    render(
      createElement(MessageBody, {
        body: "meet in #general later",
        channels,
        onOpenChannel,
      }),
    );

    const reference = screen.getByRole("button", { name: "#general" });
    fireEvent.click(reference);
    expect(onOpenChannel).toHaveBeenCalledWith(GENERAL_ID);
  });

  it("renders plain text without any buttons", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: "nothing to link here",
        channels,
        onOpenChannel: vi.fn(),
      }),
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toBe("nothing to link here");
  });

  it("keeps channel references inert when no navigation callback is provided", () => {
    const { container } = render(createElement(MessageBody, { body: "meet in #general later" }));

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toBe("meet in #general later");
  });

  it("links URLs and channel references side by side in one body", () => {
    const onOpenChannel = vi.fn();
    render(
      createElement(MessageBody, {
        body: "docs at https://example.com/guide then ask in #general",
        channels,
        onOpenChannel,
      }),
    );

    expect(screen.getByRole<HTMLAnchorElement>("link").href).toBe("https://example.com/guide");
    const reference = screen.getByRole("button", { name: "#general" });
    fireEvent.click(reference);
    expect(onOpenChannel).toHaveBeenCalledWith(GENERAL_ID);
  });

  it("keeps a channel-matching URL fragment inside the link, not as a chip", () => {
    const onOpenChannel = vi.fn();
    render(
      createElement(MessageBody, {
        body: "see https://example.com/#general please",
        channels,
        onOpenChannel,
      }),
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole<HTMLAnchorElement>("link").href).toBe("https://example.com/#general");
  });

  it("renders credential-free HTTPS URLs as external links", () => {
    render(
      createElement(MessageBody, { body: "Read https://example.com/docs?q=chat for details." }),
    );

    const link = screen.getByRole<HTMLAnchorElement>("link", {
      name: "https://example.com/docs?q=chat",
    });
    expect(link.href).toBe("https://example.com/docs?q=chat");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noreferrer");
    expect(link.closest("p")?.textContent).toBe(
      "Read https://example.com/docs?q=chat for details.",
    );
  });

  it("keeps sentence punctuation outside links while retaining balanced URL brackets", () => {
    render(createElement(MessageBody, { body: "See (https://example.com/path_(guide))." }));

    expect(screen.getByRole<HTMLAnchorElement>("link").href).toBe(
      "https://example.com/path_(guide)",
    );
    expect(screen.getByText(/See/).textContent).toBe("See (https://example.com/path_(guide)).");
  });

  it("leaves non-HTTPS and credential-bearing URLs as inert text", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: "http://example.com https://user:secret@example.com javascript:alert(1)",
      }),
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).toContain("http://example.com");
    expect(container.textContent).toContain("https://user:secret@example.com");
  });

  it("preserves multiline message text", () => {
    render(createElement(MessageBody, { body: "First line\nSecond line" }));

    expect(screen.getByText(/First line/).textContent).toBe("First line\nSecond line");
  });

  it("renders CommonMark and GFM formatting", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: "## Update\n\nUse **bold**, *emphasis*, and ~~old text~~.\n\n- First\n- Second\n\n`npm test`",
      }),
    );

    expect(screen.getByRole("heading", { level: 2, name: "Update" })).toBeTruthy();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("emphasis").tagName).toBe("EM");
    expect(screen.getByText("old text").tagName).toBe("DEL");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("npm test").tagName).toBe("CODE");
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });

  it("renders triple double quotes as one multiline blockquote when selected", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: '"""\nFirst paragraph with **formatting**.\n\n- Second item\n"""',
        fencedBlockquoteMode: "double-quote",
      }),
    );

    const quote = container.querySelector("blockquote");
    expect(container.querySelectorAll("blockquote")).toHaveLength(1);
    expect(quote?.querySelector("strong")?.textContent).toBe("formatting");
    expect(quote?.querySelector("li")?.textContent).toBe("Second item");
    expect(quote?.textContent).not.toContain('"""');
  });

  it("renders triple greater-than signs as one multiline blockquote when selected", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: ">>>\nFirst paragraph.\n\nSecond paragraph.\n>>>",
        fencedBlockquoteMode: "greater-than",
      }),
    );

    const quote = container.querySelector("blockquote");
    expect(container.querySelectorAll("blockquote")).toHaveLength(1);
    expect(
      Array.from(quote?.querySelectorAll("p") ?? [], (paragraph) => paragraph.textContent),
    ).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("keeps text after a closing quote fence outside the blockquote", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: '"""\nQuoted\n"""\nNot quoted',
        fencedBlockquoteMode: "double-quote",
      }),
    );

    expect(container.querySelector("blockquote")?.textContent.trim()).toBe("Quoted");
    expect(screen.getByText("Not quoted").closest("blockquote")).toBeNull();
  });

  it("keeps a fenced blockquote inside its list item", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: '- item\n  """\n  Quoted\n  """',
        fencedBlockquoteMode: "double-quote",
      }),
    );

    expect(container.querySelector("li blockquote")?.textContent.trim()).toBe("Quoted");
    expect(container.querySelector(".markdown-body > blockquote")).toBeNull();
  });

  it("keeps triple double quotes literal when fenced blockquotes are off", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: '"""\nNot a quote\n"""',
        fencedBlockquoteMode: "off",
      }),
    );

    expect(container.querySelector("blockquote")).toBeNull();
    expect(container.textContent).toContain('"""');
  });

  it("rerenders an existing message when the fenced blockquote preference changes", () => {
    const runtime = new FencedBlockquoteRuntime(null);
    const { container } = render(
      createElement(FencedBlockquoteProvider, {
        runtime,
        children: createElement(MessageBody, { body: '"""\nNow quoted\n"""' }),
      }),
    );

    expect(container.querySelector("blockquote")).toBeNull();
    act(() => runtime.setMode("double-quote"));
    expect(container.querySelector("blockquote")?.textContent.trim()).toBe("Now quoted");
  });

  it("keeps quote markers inside nested list code fences as code", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: '"""\n- ```text\n  """\n  ```\nStill quoted\n"""',
        fencedBlockquoteMode: "double-quote",
      }),
    );

    const quote = container.querySelector("blockquote");
    expect(container.querySelectorAll("blockquote")).toHaveLength(1);
    expect(quote?.querySelector("pre code")?.textContent).toContain('"""');
    expect(quote?.textContent).toContain("Still quoted");
  });

  it("keeps channel navigation inside formatted text but not links or code", () => {
    const onOpenChannel = vi.fn();
    const { container } = render(
      createElement(MessageBody, {
        body: "Ask **#general**, keep `#general` literal, or open [#general](https://example.com) and [**#general**](https://example.com/formatted).",
        channels,
        onOpenChannel,
      }),
    );

    const references = screen.getAllByRole("button", { name: "#general" });
    expect(references).toHaveLength(1);
    expect(references[0]?.closest("strong")).not.toBeNull();
    fireEvent.click(references[0] as HTMLElement);
    expect(onOpenChannel).toHaveBeenCalledWith(GENERAL_ID);
    expect(screen.getByText("#general", { selector: "code" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "#general (https://example.com/)" })).toBeTruthy();
    const formattedLink = screen.getByRole("link", {
      name: "#general (https://example.com/formatted)",
    });
    expect(formattedLink.querySelector("strong")?.textContent).toBe("#general");
    expect(container.querySelector("a button")).toBeNull();
  });

  it("preserves raw HTML as literal text without creating HTML elements", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: "Use <Foo /> and <b>bold</b> in the renderer",
      }),
    );

    expect(container.textContent).toBe("Use <Foo /> and <b>bold</b> in the renderer");
    expect(container.querySelector("foo")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("shows the destination when a Markdown link label could hide it", () => {
    render(
      createElement(MessageBody, {
        body: "[https://bank.example.com](https://evil.example.com/login)",
      }),
    );

    const link = screen.getByRole<HTMLAnchorElement>("link");
    expect(link.textContent).toBe("https://bank.example.com (https://evil.example.com/login)");
    expect(link.href).toBe("https://evil.example.com/login");
  });

  it("renders remote images as visible links without loading them", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: "![](https://example.com/pixel.png)",
      }),
    );

    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole<HTMLAnchorElement>("link", {
      name: "Image (https://example.com/pixel.png)",
    });
    expect(link.href).toBe("https://example.com/pixel.png");
    expect(screen.getByText("Image").classList).toContain("markdown-image-alt");
  });

  it("does not activate unsafe links", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: "[HTTP](http://example.com) [credentials](https://user:secret@example.com)",
      }),
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).toBe("HTTP credentials");
  });

  it("preserves footnote metadata and local navigation", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: "A claim.[^1]\n\n[^1]: Supporting detail.",
      }),
    );

    const label = container.querySelector<HTMLElement>("#footnote-label");
    expect(label?.classList).toContain("sr-only");
    const reference = container.querySelector<HTMLAnchorElement>('a[href="#user-content-fn-1"]');
    const backReference = container.querySelector<HTMLAnchorElement>(
      'a[href="#user-content-fnref-1"]',
    );
    expect(reference).not.toBeNull();
    expect(backReference).not.toBeNull();
  });

  it("renders known mentions as chips and leaves unknown @tokens as text", () => {
    const { container, rerender } = render(
      createElement(MessageBody, { body: "see @alex later", members: [alex] }),
    );

    const chip = container.querySelector(".mention-chip");
    expect(chip?.textContent).toBe("@alex");
    expect(chip?.getAttribute("data-mention-user-id")).toBe(ALEX_ID);

    rerender(createElement(MessageBody, { body: "ping @nobody", members: [alex] }));
    expect(container.querySelector(".mention-chip")).toBeNull();
    expect(container.textContent).toBe("ping @nobody");
  });

  it("renders mentions beside channel references", () => {
    const onOpenChannel = vi.fn();
    const { container } = render(
      createElement(MessageBody, {
        body: "ask @alex in #general",
        channels,
        members: [alex],
        onOpenChannel,
      }),
    );

    expect(container.querySelector(".mention-chip")?.textContent).toBe("@alex");
    fireEvent.click(screen.getByRole("button", { name: "#general" }));
    expect(onOpenChannel).toHaveBeenCalledWith(GENERAL_ID);
  });

  it("keeps mentions literal inside code and links", () => {
    const { container } = render(
      createElement(MessageBody, {
        body: "keep `@alex` literal or see [@alex](https://example.com)",
        members: [alex],
      }),
    );

    expect(container.querySelector(".mention-chip")).toBeNull();
    expect(screen.getByText("@alex", { selector: "code" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "@alex (https://example.com/)" })).toBeTruthy();
  });

  it("only inlines a pending suffix after a final paragraph", () => {
    const suffix = createElement("span", { className: "pending-status" }, " · sending");
    const paragraph = render(createElement(MessageBody, { body: "Sending", suffix }));
    expect(
      paragraph.container.querySelector(".markdown-body-with-suffix > p:nth-last-child(2)"),
    ).not.toBeNull();
    paragraph.unmount();

    const blocks = render(
      createElement(MessageBody, { body: "Introduction\n\n- One\n- Two", suffix }),
    );
    const messageBody = blocks.container.querySelector(".markdown-body-with-suffix");
    expect(messageBody?.children[messageBody.children.length - 2]?.tagName).toBe("UL");
    expect(
      blocks.container.querySelector(".markdown-body-with-suffix > p:nth-last-child(2)"),
    ).toBeNull();
  });
});
