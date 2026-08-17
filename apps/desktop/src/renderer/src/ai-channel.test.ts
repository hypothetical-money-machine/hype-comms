// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AiChannelState } from "@hype-comms/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiChannelTransport } from "../../shared/desktop-api";
import { AiChannel } from "./ai-channel";

const NOW = "2026-08-11T12:00:00.000Z";

function aiState(overrides: Partial<AiChannelState> = {}): AiChannelState {
  return {
    version: 1,
    generation: 1,
    status: "ready",
    workspaceName: "hype-comms",
    entries: [],
    plan: [],
    permissionRequest: null,
    error: null,
    ...overrides,
  };
}

interface TransportHarness {
  readonly transport: AiChannelTransport;
  readonly emit: (state: AiChannelState) => void;
  readonly getAiChannelState: ReturnType<typeof vi.fn<AiChannelTransport["getAiChannelState"]>>;
  readonly startAiChannel: ReturnType<typeof vi.fn<AiChannelTransport["startAiChannel"]>>;
  readonly chooseAiChannelWorkspace: ReturnType<
    typeof vi.fn<AiChannelTransport["chooseAiChannelWorkspace"]>
  >;
  readonly newAiChannelSession: ReturnType<typeof vi.fn<AiChannelTransport["newAiChannelSession"]>>;
  readonly sendAiChannelPrompt: ReturnType<typeof vi.fn<AiChannelTransport["sendAiChannelPrompt"]>>;
  readonly cancelAiChannelPrompt: ReturnType<
    typeof vi.fn<AiChannelTransport["cancelAiChannelPrompt"]>
  >;
  readonly respondAiChannelPermission: ReturnType<
    typeof vi.fn<AiChannelTransport["respondAiChannelPermission"]>
  >;
}

function createTransport(initialState: AiChannelState): TransportHarness {
  let currentState = initialState;
  let listener: ((state: AiChannelState) => void) | null = null;
  const getAiChannelState = vi.fn<AiChannelTransport["getAiChannelState"]>(
    async () => currentState,
  );
  const startAiChannel = vi.fn<AiChannelTransport["startAiChannel"]>(async () => currentState);
  const chooseAiChannelWorkspace = vi.fn<AiChannelTransport["chooseAiChannelWorkspace"]>(
    async () => currentState,
  );
  const newAiChannelSession = vi.fn<AiChannelTransport["newAiChannelSession"]>(
    async () => currentState,
  );
  const sendAiChannelPrompt = vi.fn<AiChannelTransport["sendAiChannelPrompt"]>(
    async () => currentState,
  );
  const cancelAiChannelPrompt = vi.fn<AiChannelTransport["cancelAiChannelPrompt"]>(
    async () => currentState,
  );
  const respondAiChannelPermission = vi.fn<AiChannelTransport["respondAiChannelPermission"]>(
    async () => currentState,
  );
  const transport = {
    getAiChannelState,
    startAiChannel,
    chooseAiChannelWorkspace,
    newAiChannelSession,
    sendAiChannelPrompt,
    cancelAiChannelPrompt,
    respondAiChannelPermission,
    onAiChannelStateChanged(nextListener: (state: AiChannelState) => void): () => void {
      listener = nextListener;
      return () => {
        listener = null;
      };
    },
  } satisfies AiChannelTransport;

  return {
    transport,
    emit(nextState) {
      currentState = nextState;
      listener?.(nextState);
    },
    getAiChannelState,
    startAiChannel,
    chooseAiChannelWorkspace,
    newAiChannelSession,
    sendAiChannelPrompt,
    cancelAiChannelPrompt,
    respondAiChannelPermission,
  };
}

async function renderChannel(harness: TransportHarness): Promise<void> {
  render(createElement(AiChannel, { transport: harness.transport }));
  await screen.findByRole("heading", { name: "AI Channel" });
  await waitFor(() => expect(harness.getAiChannelState).toHaveBeenCalledOnce());
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AiChannel", () => {
  it("guides workspace setup and starts the remembered folder with its generation", async () => {
    const harness = createTransport(
      aiState({ status: "not-configured", workspaceName: null, generation: 2 }),
    );
    await renderChannel(harness);

    expect(await screen.findByRole("heading", { name: "Choose where Claude works" })).toBeTruthy();
    expect(screen.getByText(/working directory, not an OS sandbox/i)).toBeTruthy();
    expect(screen.getByText(/settings may also access files outside it/i)).toBeTruthy();
    harness.chooseAiChannelWorkspace.mockResolvedValue(
      aiState({ status: "configured", workspaceName: "hype-comms", generation: 3 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(harness.chooseAiChannelWorkspace).toHaveBeenCalledOnce());

    expect(screen.getByRole("heading", { name: "hype-comms is ready to connect" })).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start Claude" });
    await waitFor(() => expect(document.activeElement).toBe(start));

    harness.startAiChannel.mockResolvedValue(
      aiState({ status: "ready", workspaceName: "hype-comms", generation: 3 }),
    );
    fireEvent.click(start);
    await waitFor(() => expect(harness.startAiChannel).toHaveBeenCalledWith({ generation: 3 }));
    const composer = await screen.findByRole("textbox", { name: "Message Claude" });
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });

  it("does not overwrite a pushed generation with stale hydration", async () => {
    let resolveHydration: ((state: AiChannelState) => void) | undefined;
    const harness = createTransport(aiState({ generation: 1, status: "not-configured" }));
    harness.getAiChannelState.mockImplementation(
      () =>
        new Promise<AiChannelState>((resolve) => {
          resolveHydration = resolve;
        }),
    );
    render(createElement(AiChannel, { transport: harness.transport }));

    act(() => {
      harness.emit(aiState({ generation: 4, status: "ready", workspaceName: "current-work" }));
    });
    expect(await screen.findByText("current-work")).toBeTruthy();

    await act(async () => {
      resolveHydration?.(aiState({ generation: 1, status: "not-configured", workspaceName: null }));
    });

    expect(screen.getByText("current-work")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Choose where Claude works" })).toBeNull();
  });

  it("does not steal focus while hidden and focuses the reject option when reopened", async () => {
    const harness = createTransport(aiState());
    const channel = (active: boolean) =>
      createElement(
        "div",
        null,
        createElement("button", { type: "button" }, "Workspace destination"),
        createElement(AiChannel, { transport: harness.transport, active }),
      );
    const view = render(channel(false));
    const workspaceDestination = screen.getByRole("button", { name: "Workspace destination" });
    workspaceDestination.focus();
    await waitFor(() => expect(harness.getAiChannelState).toHaveBeenCalledOnce());

    act(() => {
      harness.emit(
        aiState({
          status: "running",
          permissionRequest: {
            id: "permission-hidden",
            toolCallId: "tool-hidden",
            title: "Read project files",
            kind: "read",
            options: [
              { id: "allow-hidden", name: "Allow once", kind: "allow_once" },
              { id: "reject-hidden", name: "Deny", kind: "reject_once" },
            ],
          },
        }),
      );
    });

    expect(document.activeElement).toBe(workspaceDestination);
    expect(document.querySelector(".ai-channel")?.hasAttribute("hidden")).toBe(true);

    view.rerender(channel(true));
    const deny = await screen.findByRole("button", { name: "Deny" });
    await waitFor(() => expect(document.activeElement).toBe(deny));
  });

  it("restores focus to the next setup action when a permission ends the session", async () => {
    const harness = createTransport(
      aiState({
        status: "running",
        permissionRequest: {
          id: "permission-before-reconnect",
          toolCallId: "tool-before-reconnect",
          title: "Run a command",
          kind: "execute",
          options: [
            { id: "allow-before-reconnect", name: "Allow once", kind: "allow_once" },
            { id: "reject-before-reconnect", name: "Deny", kind: "reject_once" },
          ],
        },
      }),
    );
    await renderChannel(harness);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Deny" })),
    );

    act(() => {
      harness.emit(aiState({ generation: 2, status: "configured" }));
    });

    const start = await screen.findByRole("button", { name: "Start Claude" });
    await waitFor(() => expect(document.activeElement).toBe(start));
  });

  it("follows streamed output only while the reader stays near the tail", async () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const firstEntry = {
      type: "message" as const,
      id: "user-scroll",
      role: "user" as const,
      body: "Inspect the renderer",
      createdAt: NOW,
    };
    const harness = createTransport(aiState({ status: "running", entries: [firstEntry] }));
    await renderChannel(harness);
    scrollIntoView.mockClear();

    const stream = document.querySelector<HTMLDivElement>(".ai-channel-stream");
    expect(stream).not.toBeNull();
    if (stream === null) return;
    Object.defineProperties(stream, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
    });

    stream.scrollTop = 120;
    fireEvent.scroll(stream);
    act(() => {
      harness.emit(
        aiState({
          status: "running",
          entries: [
            firstEntry,
            {
              type: "message",
              id: "assistant-scroll-1",
              role: "assistant",
              body: "First streamed update",
              createdAt: NOW,
            },
          ],
        }),
      );
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    stream.scrollTop = 700;
    fireEvent.scroll(stream);
    act(() => {
      harness.emit(
        aiState({
          status: "running",
          entries: [
            firstEntry,
            {
              type: "message",
              id: "assistant-scroll-1",
              role: "assistant",
              body: "First streamed update",
              createdAt: NOW,
            },
            {
              type: "message",
              id: "assistant-scroll-2",
              role: "assistant",
              body: "Second streamed update",
              createdAt: NOW,
            },
          ],
        }),
      );
    });
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("renders streamed messages, thoughts, tools, plans, and an exact permission choice", async () => {
    const harness = createTransport(
      aiState({
        generation: 7,
        status: "running",
        entries: [
          { type: "message", id: "user-1", role: "user", body: "Run the tests", createdAt: NOW },
          {
            type: "message",
            id: "assistant-1",
            role: "assistant",
            body: "I’ll inspect the focused suite.",
            createdAt: NOW,
          },
          {
            type: "message",
            id: "thought-1",
            role: "thought",
            body: "The desktop workspace is the narrowest target.",
            createdAt: NOW,
          },
          {
            type: "tool",
            id: "tool-1",
            title: "Run focused desktop tests",
            kind: "execute",
            status: "in_progress",
            locations: ["apps/desktop", "apps/desktop/src/renderer"],
            createdAt: NOW,
          },
        ],
        plan: [
          { content: "Inspect the renderer", priority: "high", status: "completed" },
          { content: "Run focused tests", priority: "high", status: "in_progress" },
        ],
        permissionRequest: {
          id: "permission-1",
          toolCallId: "tool-1",
          title: "Run focused desktop tests",
          kind: "execute",
          options: [
            { id: "allow-once", name: "Allow once", kind: "allow_once" },
            { id: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      }),
    );
    await renderChannel(harness);

    expect(
      (await screen.findByRole("article", { name: "Message from You" })).textContent,
    ).toContain("Run the tests");
    expect(screen.getByRole("article", { name: "Message from Claude" }).textContent).toContain(
      "I’ll inspect the focused suite.",
    );
    expect(screen.getByText("Claude’s notes")).toBeTruthy();
    expect(screen.getByText("The desktop workspace is the narrowest target.")).toBeTruthy();
    expect(screen.getAllByText("Run focused desktop tests")).toHaveLength(2);
    expect(screen.getByText("In progress")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();

    const permission = screen.getByRole("alertdialog", { name: "Run focused desktop tests" });
    expect(permission.textContent).toContain("not a sandbox");
    expect(permission.textContent).toContain("may access files outside it");
    const allow = screen.getByRole("button", { name: "Allow once" });
    const deny = screen.getByRole("button", { name: "Deny" });
    await waitFor(() => expect(document.activeElement).toBe(deny));
    fireEvent.click(allow);
    await waitFor(() =>
      expect(harness.respondAiChannelPermission).toHaveBeenCalledWith({
        generation: 7,
        requestId: "permission-1",
        optionId: "allow-once",
      }),
    );
    act(() => {
      harness.emit(aiState({ generation: 7, status: "running", permissionRequest: null }));
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })),
    );
  });

  it("renders Markdown in user and assistant messages", async () => {
    const harness = createTransport(
      aiState({
        entries: [
          {
            type: "message",
            id: "user-markdown",
            role: "user",
            body: "Please check **the renderer**.",
            createdAt: NOW,
          },
          {
            type: "message",
            id: "assistant-markdown",
            role: "assistant",
            body: "1. Run `npm test`\n2. Review the [docs](https://example.com/docs)",
            createdAt: NOW,
          },
        ],
      }),
    );
    await renderChannel(harness);

    expect(screen.getByText("the renderer").tagName).toBe("STRONG");
    expect(screen.getByText("npm test").tagName).toBe("CODE");
    expect(document.querySelectorAll(".ai-channel-message-body li")).toHaveLength(2);
    expect(
      screen.getByRole("link", { name: "docs (https://example.com/docs)" }).getAttribute("href"),
    ).toBe("https://example.com/docs");
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Command", { metaKey: true }],
  ])("submits a trimmed prompt with %s+Enter", async (_label, modifier) => {
    const harness = createTransport(aiState({ generation: 5 }));
    await renderChannel(harness);
    const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Message Claude",
    });
    fireEvent.change(input, { target: { value: "  Explain this cache path.  " } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.sendAiChannelPrompt).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ...modifier });

    await waitFor(() =>
      expect(harness.sendAiChannelPrompt).toHaveBeenCalledWith({
        generation: 5,
        prompt: "Explain this cache path.",
      }),
    );
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("keeps a failed prompt draft and exposes the sanitized error", async () => {
    const harness = createTransport(aiState({ generation: 8 }));
    harness.sendAiChannelPrompt.mockRejectedValue(new Error("Claude is not authenticated."));
    await renderChannel(harness);
    const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Message Claude",
    });
    fireEvent.change(input, { target: { value: "Help with this test" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Claude is not authenticated.",
    );
    expect(input.value).toBe("Help with this test");
  });

  it("offers cancellation while running, then new-chat and folder controls when ready", async () => {
    const harness = createTransport(aiState({ status: "running", generation: 11 }));
    await renderChannel(harness);

    expect(screen.getByRole("textbox", { name: "Message Claude" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "New chat" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(harness.cancelAiChannelPrompt).toHaveBeenCalledWith({ generation: 11 }),
    );

    act(() => {
      harness.emit(aiState({ status: "ready", generation: 12 }));
    });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() =>
      expect(harness.newAiChannelSession).toHaveBeenCalledWith({ generation: 12 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
    await waitFor(() => expect(harness.chooseAiChannelWorkspace).toHaveBeenCalledOnce());
  });

  it("shows unavailable guidance with retry and folder recovery", async () => {
    const harness = createTransport(
      aiState({
        status: "unavailable",
        generation: 13,
        workspaceName: null,
        error: "Claude Code support is not installed in this build.",
      }),
    );
    await renderChannel(harness);

    expect(
      await screen.findByRole("heading", { name: "AI Channel can’t connect yet" }),
    ).toBeTruthy();
    expect(screen.getByText("Claude Code support is not installed in this build.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(harness.startAiChannel).toHaveBeenCalledWith({ generation: 13 }));
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(harness.chooseAiChannelWorkspace).toHaveBeenCalledOnce());
  });
});
