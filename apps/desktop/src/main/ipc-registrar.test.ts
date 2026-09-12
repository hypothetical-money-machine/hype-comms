import { describe, expect, it, vi } from "vitest";
import type { User } from "@hype-comms/contracts";

import { DESKTOP_INITIAL_CHANNELS, DESKTOP_PUSH_CHANNELS } from "../shared/channels";
import {
  DESKTOP_INVOKE_CONTRACTS,
  type DesktopInvokeHandlers,
  type DesktopInvokeName,
} from "../shared/ipc-invoke-contract";
import { createDesktopInvoker, parseInvokeResult } from "../shared/ipc-invoke";
import { readDesktopInitialValues } from "../shared/ipc-initial-values";
import { registerDesktopInitialValues, type IpcInitialValueRegistry } from "./ipc-initial-values";
import { registerDesktopInvokes, type IpcInvokeRegistry } from "./ipc-registrar";
import {
  createWorkspaceInvokeHandlers,
  type WorkspaceIpcTransport,
} from "./workspace-ipc-handlers";

interface TestEvent {
  readonly trusted: boolean;
  readonly senderId: number;
}

const TRUSTED = { trusted: true, senderId: 7 };
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000001";
const EMPTY_TASKS = { tasks: [], nextCursor: null, hasMore: false };
const USER: User = {
  id: "10000000-0000-4000-8000-000000000002",
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  title: "Engineer",
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
};

function unexpected(): never {
  throw new Error("Unexpected desktop operation");
}

function handlers(overrides: Partial<DesktopInvokeHandlers> = {}): DesktopInvokeHandlers {
  // Every generated entry has the same () => never type, which is valid for every handler.
  const defaults = Object.fromEntries(
    Object.keys(DESKTOP_INVOKE_CONTRACTS).map((name) => [name, unexpected]),
  ) as Record<DesktopInvokeName, typeof unexpected>;
  return { ...defaults, ...overrides };
}

function workspaceTransport(overrides: Partial<WorkspaceIpcTransport> = {}): WorkspaceIpcTransport {
  return {
    members: unexpected,
    updateProfile: unexpected,
    communicationPaths: unexpected,
    listAgentEnrollments: unexpected,
    reviewAgentEnrollment: unexpected,
    cancelAgentEnrollment: unexpected,
    conversations: unexpected,
    history: unexpected,
    messageById: unexpected,
    retractMessage: unexpected,
    searchMessages: unexpected,
    attachments: unexpected,
    conversationFiles: unexpected,
    tasks: unexpected,
    myTasks: unexpected,
    createTask: unexpected,
    updateTask: unexpected,
    moveTask: unexpected,
    thread: unexpected,
    reactions: unexpected,
    addReaction: unexpected,
    removeReaction: unexpected,
    send: unexpected,
    createChannel: unexpected,
    archiveChannel: unexpected,
    channelMembers: unexpected,
    upsertChannelMember: unexpected,
    removeChannelMember: unexpected,
    createDirectConversation: unexpected,
    sync: unexpected,
    ...overrides,
  };
}

class Registry implements IpcInvokeRegistry<TestEvent> {
  readonly listeners = new Map<
    string,
    (event: TestEvent, ...args: unknown[]) => Promise<unknown>
  >();
  failChannel: string | null = null;

  handle(
    channel: string,
    listener: (event: TestEvent, ...args: unknown[]) => Promise<unknown>,
  ): void {
    if (channel === this.failChannel) throw new Error("Injected registration failure");
    if (this.listeners.has(channel)) throw new Error("Duplicate handler");
    this.listeners.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.listeners.delete(channel);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return this.dispatch(channel, TRUSTED, ...args);
  }

  async dispatch(channel: string, event: TestEvent, ...args: unknown[]): Promise<unknown> {
    const listener = this.listeners.get(channel);
    if (listener === undefined) throw new Error("Missing handler");
    return listener(event, ...args);
  }
}

const authorize = (event: TestEvent) => (event.trusted ? { senderId: event.senderId } : null);

describe("desktop invoke registration", () => {
  it("registers distinct invoke channels and leaves sync and push channels separate", () => {
    const registry = new Registry();
    registerDesktopInvokes(registry, authorize, handlers());
    expect(registry.listeners.size).toBe(Object.keys(DESKTOP_INVOKE_CONTRACTS).length);
    for (const channel of [
      ...Object.values(DESKTOP_INITIAL_CHANNELS),
      ...Object.values(DESKTOP_PUSH_CHANNELS),
    ]) {
      expect(registry.listeners.has(channel)).toBe(false);
    }
  });

  it("rejects every untrusted invocation before inspecting arguments or accessing a service", async () => {
    const registry = new Registry();
    const toJSON = vi.fn(() => {
      throw new Error("Arguments inspected");
    });
    registerDesktopInvokes(registry, authorize, handlers());
    for (const { channel } of Object.values(DESKTOP_INVOKE_CONTRACTS)) {
      await expect(
        registry.dispatch(channel, { ...TRUSTED, trusted: false }, { toJSON }),
      ).rejects.toThrow("Untrusted desktop IPC sender");
    }
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("parses task defaults and rejects unknown fields, extra arguments, and oversized requests before service access", async () => {
    const registry = new Registry();
    const tasks = vi.fn<WorkspaceIpcTransport["tasks"]>().mockResolvedValue(EMPTY_TASKS);
    const transport = workspaceTransport({ tasks });
    registerDesktopInvokes(
      registry,
      authorize,
      handlers(createWorkspaceInvokeHandlers(() => transport)),
    );
    const { channel } = DESKTOP_INVOKE_CONTRACTS.workspaceTasksList;
    const request = { conversationId: CONVERSATION_ID, query: {} };
    await expect(registry.invoke(channel, request)).resolves.toEqual(EMPTY_TASKS);
    expect(tasks).toHaveBeenCalledWith(CONVERSATION_ID, { limit: 100 });
    tasks.mockClear();
    await expect(
      registry.invoke(channel, { ...request, credentials: "forbidden" }),
    ).rejects.toThrow();
    await expect(registry.invoke(channel, request, "extra")).rejects.toThrow();
    await expect(
      registry.invoke(channel, { ...request, padding: "x".repeat(65_536) }),
    ).rejects.toThrow("byte limit");
    await expect(
      registry.invoke(channel, {
        ...request,
        query: { dueAfter: "2026-09-13", dueBefore: "2026-09-12" },
      }),
    ).rejects.toThrow();
    expect(tasks).not.toHaveBeenCalled();
  });

  it("runs task reads through both boundaries and resolves the current transport for each call", async () => {
    const registry = new Registry();
    const tasks = vi.fn<WorkspaceIpcTransport["tasks"]>().mockResolvedValue(EMPTY_TASKS);
    let current: WorkspaceIpcTransport | null = workspaceTransport({ tasks });
    registerDesktopInvokes(
      registry,
      authorize,
      handlers(createWorkspaceInvokeHandlers(() => current)),
    );
    const invoke = createDesktopInvoker(registry);
    await expect(
      invoke("workspaceTasksList", { conversationId: CONVERSATION_ID, query: {} }),
    ).resolves.toEqual(EMPTY_TASKS);
    current = null;
    await expect(
      invoke("workspaceTasksList", { conversationId: CONVERSATION_ID, query: {} }),
    ).rejects.toThrow("Workspace transport is unavailable");
    expect(tasks).toHaveBeenCalledTimes(1);
  });

  it("wraps the transport's user in the profile response required by preload", async () => {
    const registry = new Registry();
    const updateProfile = vi.fn<WorkspaceIpcTransport["updateProfile"]>().mockResolvedValue(USER);
    const transport = workspaceTransport({ updateProfile });
    registerDesktopInvokes(
      registry,
      authorize,
      handlers(createWorkspaceInvokeHandlers(() => transport)),
    );
    await expect(
      createDesktopInvoker(registry)("workspaceProfileUpdate", "Engineer"),
    ).resolves.toEqual({ user: USER });
    expect(updateProfile).toHaveBeenCalledWith("Engineer");
  });

  it("passes trusted sender identity and preserves handler authorization errors", async () => {
    const registry = new Registry();
    const scopeError = new Error("Notification activity does not match the active renderer");
    const notificationContext = vi.fn<DesktopInvokeHandlers["notificationContext"]>(() => {
      throw scopeError;
    });
    registerDesktopInvokes(registry, authorize, handlers({ notificationContext }));
    await expect(createDesktopInvoker(registry)("notificationContext")).rejects.toBe(scopeError);
    expect(notificationContext).toHaveBeenCalledWith({ senderId: 7 });
  });

  it("rejects malformed service output before it leaves main and malformed IPC output in preload", async () => {
    const registry = new Registry();
    const malformed = { ...EMPTY_TASKS, secret: "must not cross IPC" };
    registerDesktopInvokes(
      registry,
      authorize,
      handlers({ workspaceMyTasksList: () => malformed }),
    );
    await expect(
      registry.invoke(DESKTOP_INVOKE_CONTRACTS.workspaceMyTasksList.channel, {}),
    ).rejects.toThrow();
    const invoke = createDesktopInvoker({ invoke: async () => malformed });
    await expect(invoke("workspaceMyTasksList", {})).rejects.toThrow();
    expect(() =>
      parseInvokeResult("notificationContext", { padding: "x".repeat(64 * 1_024) }),
    ).toThrow("byte limit");
  });

  it("accepts void results and enforces no-argument invokes", async () => {
    const registry = new Registry();
    registerDesktopInvokes(registry, authorize, handlers({ updateCheck: () => undefined }));
    await expect(createDesktopInvoker(registry)("updateCheck")).resolves.toBeUndefined();
    await expect(
      registry.invoke(DESKTOP_INVOKE_CONTRACTS.updateCheck.channel, {}),
    ).rejects.toThrow();
    expect(() => parseInvokeResult("updateCheck", { accepted: true })).toThrow(
      "unexpected payload",
    );
  });

  it("replaces handlers without letting an old disposer remove the replacement", async () => {
    const registry = new Registry();
    const oldDispose = registerDesktopInvokes(
      registry,
      authorize,
      handlers({ appVersion: () => "1" }),
    );
    const dispose = registerDesktopInvokes(
      registry,
      authorize,
      handlers({ appVersion: () => "2" }),
    );
    oldDispose();
    oldDispose();
    await expect(createDesktopInvoker(registry)("appVersion")).resolves.toBe("2");
    dispose();
    dispose();
    expect(registry.listeners.size).toBe(0);
  });

  it.each(["dispose", "replace"] as const)("rejects a late response after %s", async (action) => {
    const registry = new Registry();
    let resolve: (value: string) => void = unexpected;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const dispose = registerDesktopInvokes(
      registry,
      authorize,
      handlers({ appVersion: () => pending }),
    );
    const response = createDesktopInvoker(registry)("appVersion");
    if (action === "dispose") dispose();
    else registerDesktopInvokes(registry, authorize, handlers({ appVersion: () => "2" }));
    resolve("1");
    await expect(response).rejects.toThrow("registration was disposed");
  });

  it("cleans up a partially installed registration", () => {
    const registry = new Registry();
    registry.failChannel = DESKTOP_INVOKE_CONTRACTS.workspaceTaskCreate.channel;
    expect(() => registerDesktopInvokes(registry, authorize, handlers())).toThrow(
      "Injected registration failure",
    );
    expect(registry.listeners.size).toBe(0);
  });

  it("requires complete handler coverage at compile time", () => {
    const { workspaceTaskCreate: omitted, ...incomplete } = handlers();
    void omitted;
    // @ts-expect-error An omitted invoke handler must be a compile error.
    const rejected: DesktopInvokeHandlers = incomplete;
    void rejected;
  });
});

describe("synchronous initial values", () => {
  it("replaces and disposes only its own listener and validates the initial reply", () => {
    type Listener = Parameters<IpcInitialValueRegistry["on"]>[1];
    const listeners = new Set<Listener>();
    const registry: IpcInitialValueRegistry = {
      on: (_channel, listener) => listeners.add(listener),
      removeListener: (_channel, listener) => listeners.delete(listener),
    };
    const read = () =>
      readDesktopInitialValues({
        sendSync: () => {
          const event = { returnValue: undefined as unknown };
          for (const listener of listeners) listener(event);
          return event.returnValue;
        },
      });
    const oldDispose = registerDesktopInitialValues(registry, () => ({
      automationHeadless: false,
    }));
    expect(read()).toEqual({ automationHeadless: false });
    const dispose = registerDesktopInitialValues(registry, () => ({ automationHeadless: true }));
    oldDispose();
    expect(listeners.size).toBe(1);
    expect(read()).toEqual({ automationHeadless: true });
    dispose();
    dispose();
    expect(listeners.size).toBe(0);
    expect(() => readDesktopInitialValues({ sendSync: () => "true" })).toThrow();
  });
});
