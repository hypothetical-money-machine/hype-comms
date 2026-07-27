// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelCreatePopover } from "./channel-create-popover";

function renderPopover(onCreate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)) {
  render(
    createElement(
      "nav",
      null,
      createElement(
        "div",
        { className: "nav-heading" },
        createElement(ChannelCreatePopover, { onCreate }),
      ),
    ),
  );
  return {
    onCreate,
    trigger: screen.getByRole("button", { name: "Create channel" }),
  };
}

function open(trigger: HTMLElement): HTMLInputElement {
  fireEvent.click(trigger);
  return screen.getByRole("textbox", { name: "Channel name" });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChannelCreatePopover", () => {
  it("owns toggle state and resets the form whenever it closes", () => {
    const { trigger } = renderPopover();
    const input = open(trigger);
    fireEvent.change(input, { target: { value: "Launch Planning" } });
    expect(screen.getByText("#launch-planning")).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
    const reopened = open(trigger);
    expect(reopened.value).toBe("");
    expect(screen.getByText("#channel-name")).toBeTruthy();
  });

  it("dismisses outside and on Escape, then restores focus to the trigger", async () => {
    const { trigger } = renderPopover();
    open(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    open(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("locks every close route while creation is pending and closes after success", async () => {
    let resolveCreate: (() => void) | undefined;
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { trigger } = renderPopover(onCreate);
    const input = open(trigger);
    fireEvent.change(input, { target: { value: "Équipe Produit" } });
    fireEvent.submit(screen.getByRole("dialog"));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith("Équipe Produit", "équipe-produit", "workspace"),
    );
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Close channel creation" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();

    resolveCreate?.();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("retains the form and displays a creation failure", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("That channel already exists"));
    const { trigger } = renderPopover(onCreate);
    const input = open(trigger);
    fireEvent.change(input, { target: { value: "Design" } });
    fireEvent.submit(screen.getByRole("dialog"));

    expect(await screen.findByText("That channel already exists")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Channel name" }).value).toBe(
      "Design",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("previews normalized Unicode and explains emoji-only names", () => {
    const { trigger } = renderPopover();
    const input = open(trigger);
    fireEvent.change(input, { target: { value: "產品 हिन्दी" } });
    expect(screen.getByText("#產品-हिन्दी")).toBeTruthy();

    fireEvent.change(input, { target: { value: "👋✨" } });
    expect(screen.getByText(/symbols and emoji alone cannot form a channel/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);
  });

  it("creates an invited-members channel when private access is selected", async () => {
    const { onCreate, trigger } = renderPopover();
    const input = open(trigger);
    fireEvent.change(input, { target: { value: "Leadership" } });
    fireEvent.click(screen.getByRole("radio", { name: /invited members/i }));
    fireEvent.submit(screen.getByRole("dialog"));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith("Leadership", "leadership", "members"),
    );
  });

  it("anchors the portal to the trigger and recalculates after sidebar scroll", async () => {
    const { trigger } = renderPopover();
    let anchorLeft = 360;
    vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          left: anchorLeft,
          right: anchorLeft + 40,
          top: 100,
          bottom: 120,
          width: 40,
          height: 20,
          x: anchorLeft,
          y: 100,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    open(trigger);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog.style.left).toBe("80px"));
    expect(dialog.style.top).toBe("130px");
    expect(dialog.parentElement).toBe(document.body);

    anchorLeft = 300;
    fireEvent.scroll(document);
    await waitFor(() => expect(dialog.style.left).toBe("20px"));
  });
});
