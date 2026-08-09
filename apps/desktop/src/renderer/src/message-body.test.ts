// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageBody } from "./message-body";

const GENERAL_ID = "10000000-0000-4000-8000-000000000001";

const channels = [{ conversationId: GENERAL_ID, slug: "general" }];

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
    render(
      createElement(MessageBody, {
        body: "http://example.com https://user:secret@example.com javascript:alert(1)",
      }),
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/http:\/\/example.com/).textContent).toContain(
      "https://user:secret@example.com",
    );
  });

  it("preserves multiline message text", () => {
    render(createElement(MessageBody, { body: "First line\nSecond line" }));

    expect(screen.getByText(/First line/).textContent).toBe("First line\nSecond line");
  });
});
