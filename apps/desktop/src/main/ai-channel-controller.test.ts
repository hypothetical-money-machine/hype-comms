import { aiChannelStateSchema, type AiChannelState } from "@hype-comms/contracts";
import { describe, expect, it } from "vitest";

import {
  AiAgentHostError,
  type AiAgentHost,
  type AiAgentHostCallbacks,
  type AiAgentHostEvent,
  type AiAgentHostPermissionRequest,
  type CreateAiAgentHost,
} from "./ai-agent-host";
import { AiChannelController } from "./ai-channel-controller";
import type { AiChannelPreference } from "./ai-channel-preference-store";

const WORKSPACE = "/private/projects/secret-repo";
const NOW = new Date("2026-08-11T18:00:00.000Z");

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: ((value: Value) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value),
    reject: (error) => reject?.(error),
  };
}

class FakePreferenceStore {
  readonly saves: AiChannelPreference[] = [];
  loadError: Error | null = null;

  constructor(readonly loaded: AiChannelPreference = { workspacePath: null, sessionId: null }) {}

  async load(): Promise<AiChannelPreference> {
    await Promise.resolve();
    if (this.loadError !== null) throw this.loadError;
    return this.loaded;
  }

  async save(preference: AiChannelPreference): Promise<void> {
    await Promise.resolve();
    this.saves.push(preference);
  }
}

class FakeHost implements AiAgentHost {
  readonly newConversationCalls: string[] = [];
  readonly resumeConversationCalls: Array<{ workspacePath: string; conversationId: string }> = [];
  readonly promptCalls: Array<{ conversationId: string; prompt: string }> = [];
  readonly cancelCalls: string[] = [];
  readonly closeCalls: string[] = [];
  disposeCalls = 0;
  nextConversationId = "new-session";
  resumeError: Error | null = null;
  newConversationError: Error | null = null;
  promptGate: Deferred<void> | null = null;
  cancelGate: Deferred<void> | null = null;
  disposeGate: Deferred<void> | null = null;

  async newConversation(workspacePath: string): Promise<{ conversationId: string }> {
    this.newConversationCalls.push(workspacePath);
    if (this.newConversationError !== null) throw this.newConversationError;
    return { conversationId: this.nextConversationId };
  }

  async resumeConversation(workspacePath: string, conversationId: string): Promise<void> {
    this.resumeConversationCalls.push({ workspacePath, conversationId });
    if (this.resumeError !== null) throw this.resumeError;
  }

  prompt(conversationId: string, prompt: string): Promise<void> {
    this.promptCalls.push({ conversationId, prompt });
    return this.promptGate?.promise ?? Promise.resolve();
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
    if (this.cancelGate !== null) await this.cancelGate.promise;
  }

  async close(sessionId: string): Promise<void> {
    this.closeCalls.push(sessionId);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.disposeGate !== null) await this.disposeGate.promise;
  }
}

interface Harness {
  readonly controller: AiChannelController;
  readonly preferences: FakePreferenceStore;
  readonly host: FakeHost;
  readonly callbacks: () => AiAgentHostCallbacks;
  readonly factoryCalls: () => number;
}

function createHarness(
  loaded: AiChannelPreference = { workspacePath: WORKSPACE, sessionId: null },
): Harness {
  const preferences = new FakePreferenceStore(loaded);
  const host = new FakeHost();
  let capturedCallbacks: AiAgentHostCallbacks | null = null;
  let factoryCalls = 0;
  const hostFactory: CreateAiAgentHost = async (callbacks) => {
    factoryCalls += 1;
    capturedCallbacks = callbacks;
    return host;
  };
  const controller = new AiChannelController({
    preferenceStore: preferences,
    hostFactory,
    now: () => NOW,
  });
  return {
    controller,
    preferences,
    host,
    callbacks: () => {
      if (capturedCallbacks === null) throw new Error("Host has not started");
      return capturedCallbacks;
    },
    factoryCalls: () => factoryCalls,
  };
}

function textUpdate(
  conversationId: string,
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
  text: string,
  messageId = "message-from-acp",
): AiAgentHostEvent {
  return {
    type: "message-update",
    conversationId,
    messageId,
    role:
      sessionUpdate === "user_message_chunk"
        ? "user"
        : sessionUpdate === "agent_message_chunk"
          ? "assistant"
          : "thought",
    operation: "append",
    text,
  };
}

function permissionRequest(conversationId = "new-session"): AiAgentHostPermissionRequest {
  return {
    conversationId,
    tool: {
      id: "raw-tool-id",
      title: `Edit ${WORKSPACE}/src/index.ts`,
      kind: "edit",
      status: "pending",
      locations: [{ path: `${WORKSPACE}/src/index.ts`, line: 12 }],
    },
    options: [
      { id: "raw-allow", name: "Allow new-session once", kind: "allow_once" },
      { id: "raw-reject", name: "Reject", kind: "reject_once" },
    ],
  };
}

async function startReady(harness: Harness): Promise<AiChannelState> {
  const initialized = await harness.controller.initialize();
  return harness.controller.start({ generation: initialized.generation });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AiChannelController", () => {
  it("initializes as configured without exposing the persisted path or session", async () => {
    const harness = createHarness({ workspacePath: WORKSPACE, sessionId: "persisted-session" });

    const state = await harness.controller.initialize();

    expect(state).toEqual({
      version: 1,
      generation: 1,
      status: "configured",
      workspaceName: "secret-repo",
      entries: [],
      plan: [],
      permissionRequest: null,
      error: null,
    });
    expect(JSON.stringify(state)).not.toContain(WORKSPACE);
    expect(JSON.stringify(state)).not.toContain("persisted-session");
    expect(harness.factoryCalls()).toBe(0);
    expect(aiChannelStateSchema.safeParse(state).success).toBe(true);
  });

  it("publishes a valid unavailable state when device preferences cannot be loaded", async () => {
    const preferences = new FakePreferenceStore();
    preferences.loadError = new Error(`cannot read ${WORKSPACE}/preferences.json`);
    const controller = new AiChannelController({
      preferenceStore: preferences,
      hostFactory: async () => new FakeHost(),
      now: () => NOW,
    });

    const state = await controller.initialize();

    expect(state).toMatchObject({
      status: "unavailable",
      workspaceName: null,
      error: "AI Channel preferences could not be loaded on this device.",
    });
    expect(controller.state).toEqual(state);
    expect(aiChannelStateSchema.safeParse(state).success).toBe(true);
    expect(JSON.stringify(state)).not.toContain(WORKSPACE);
  });

  it("persists only canonical absolute workspace choices and advances the generation", async () => {
    const harness = createHarness({ workspacePath: null, sessionId: null });
    const initialized = await harness.controller.initialize();

    await expect(harness.controller.chooseWorkspace("relative/folder")).rejects.toThrow(
      /canonical absolute/,
    );
    await expect(harness.controller.chooseWorkspace("/tmp/../private/project")).rejects.toThrow(
      /canonical absolute/,
    );

    const state = await harness.controller.chooseWorkspace(WORKSPACE);

    expect(state).toMatchObject({
      generation: initialized.generation + 1,
      status: "configured",
      workspaceName: "secret-repo",
    });
    expect(harness.preferences.saves).toEqual([{ workspacePath: WORKSPACE, sessionId: null }]);
    expect(JSON.stringify(state)).not.toContain(WORKSPACE);
  });

  it("starts lazily, loads the persisted session, and saves the main-only association", async () => {
    const harness = createHarness({ workspacePath: WORKSPACE, sessionId: "persisted-session" });
    const initialized = await harness.controller.initialize();
    const statuses: string[] = [];
    harness.controller.subscribe((state) => statuses.push(state.status));

    expect(harness.factoryCalls()).toBe(0);
    const state = await harness.controller.start({ generation: initialized.generation });

    expect(state.status).toBe("ready");
    expect(harness.factoryCalls()).toBe(1);
    expect(harness.host.resumeConversationCalls).toEqual([
      { workspacePath: WORKSPACE, conversationId: "persisted-session" },
    ]);
    expect(harness.host.newConversationCalls).toEqual([]);
    expect(harness.preferences.saves).toEqual([
      { workspacePath: WORKSPACE, sessionId: "persisted-session" },
    ]);
    expect(statuses).toEqual(["starting", "ready"]);
  });

  it("falls back to exactly one new session when the persisted conversation is missing", async () => {
    const harness = createHarness({ workspacePath: WORKSPACE, sessionId: "stale-session" });
    harness.host.resumeError = new AiAgentHostError("conversation-not-found");
    harness.host.nextConversationId = "replacement-session";

    const state = await startReady(harness);

    expect(state.status).toBe("ready");
    expect(harness.host.resumeConversationCalls).toHaveLength(1);
    expect(harness.host.newConversationCalls).toEqual([WORKSPACE]);
    expect(harness.preferences.saves.at(-1)).toEqual({
      workspacePath: WORKSPACE,
      sessionId: "replacement-session",
    });
    expect(JSON.stringify(state)).not.toContain("stale-session");
    expect(JSON.stringify(state)).not.toContain("replacement-session");
  });

  it("does not replace a persisted conversation after another resume failure", async () => {
    const harness = createHarness({ workspacePath: WORKSPACE, sessionId: "persisted-session" });
    harness.host.resumeError = new AiAgentHostError("conversation-failed");

    const state = await startReady(harness);

    expect(state).toMatchObject({
      status: "error",
      error:
        "Claude Code could not open the selected workspace. Check Claude Code sign-in and folder access, then retry.",
    });
    expect(harness.host.resumeConversationCalls).toEqual([
      { workspacePath: WORKSPACE, conversationId: "persisted-session" },
    ]);
    expect(harness.host.newConversationCalls).toEqual([]);
    expect(harness.preferences.saves).toEqual([]);
    expect(harness.host.disposeCalls).toBe(1);
  });

  it("projects neutral message, thought, tool, and plan updates without absolute paths", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);

    const running = await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: `Inspect ${WORKSPACE}/src/index.ts`,
    });
    expect(running.status).toBe("running");
    expect(harness.host.promptCalls).toEqual([
      { conversationId: "new-session", prompt: `Inspect ${WORKSPACE}/src/index.ts` },
    ]);
    await expect(
      harness.controller.sendPrompt({ generation: running.generation, prompt: "second" }),
    ).rejects.toThrow(/not ready/);

    const callbacks = harness.callbacks();
    callbacks.onEvent(
      textUpdate(
        "new-session",
        "agent_message_chunk",
        `Opened ${WORKSPACE}/src/index.ts; failed:/etc/passwd URL https://example.test/docs/path session new-`,
      ),
    );
    callbacks.onEvent(textUpdate("new-session", "agent_message_chunk", "session"));
    callbacks.onEvent(textUpdate("new-session", "agent_thought_chunk", `Thinking in ${WORKSPACE}`));
    callbacks.onEvent({
      type: "tool-update",
      conversationId: "new-session",
      isCreation: true,
      tool: {
        id: "raw-tool-id",
        title: `Read ${WORKSPACE}/src/index.ts in new-session`,
        kind: "read",
        status: "in_progress",
        locations: [
          { path: `${WORKSPACE}/src/index.ts`, line: 7 },
          { path: "/home/person/private.txt" },
        ],
      },
    });
    callbacks.onEvent({
      type: "plan-replace",
      conversationId: "new-session",
      entries: [
        {
          content: `Review ${WORKSPACE}/src/index.ts for new-session`,
          priority: "high",
          status: "in_progress",
        },
      ],
    });

    const state = harness.controller.state;
    const serialized = JSON.stringify(state);
    expect(state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          body: "Opened ./src/index.ts; failed:[path] URL https://example.test/docs/path session [session]",
        }),
        expect.objectContaining({ role: "thought", body: "Thinking in ." }),
        expect.objectContaining({
          type: "tool",
          title: "Read ./src/index.ts in [session]",
          locations: ["src/index.ts:7", "Outside workspace/private.txt"],
        }),
      ]),
    );
    expect(state.plan).toEqual([
      {
        content: "Review ./src/index.ts for [session]",
        priority: "high",
        status: "in_progress",
      },
    ]);
    expect(serialized).not.toContain(WORKSPACE);
    expect(serialized).not.toContain("raw-tool-id");
    expect(serialized).not.toContain("new-session");

    harness.host.promptGate.resolve(undefined);
    await flushPromises();
    expect(harness.controller.state.status).toBe("ready");
  });

  it("redacts paths split across streamed chunks and home-relative paths", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Inspect paths",
    });
    const callbacks = harness.callbacks();

    callbacks.onEvent(
      textUpdate("new-session", "agent_message_chunk", "Opened /home/", "split-path"),
    );
    callbacks.onEvent(
      textUpdate("new-session", "agent_message_chunk", "alice/secret.txt", "split-path"),
    );
    callbacks.onEvent(
      textUpdate("new-session", "agent_message_chunk", "See ~/private.txt now", "home-path"),
    );
    callbacks.onEvent(
      textUpdate(
        "new-session",
        "agent_message_chunk",
        'Path {"path":"/home/alice/file.txt","mode":"safe"}',
        "json-path",
      ),
    );

    expect(harness.controller.state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", body: "Opened [path]" }),
        expect.objectContaining({ role: "assistant", body: "See [path] now" }),
        expect.objectContaining({
          role: "assistant",
          body: 'Path {"path":"[path]","mode":"safe"}',
        }),
      ]),
    );
    expect(
      harness.controller.state.entries.filter(
        (entry) => entry.type === "message" && entry.body === "Opened [path]",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(harness.controller.state)).not.toMatch(
      /home|alice|secret\.txt|private\.txt/u,
    );
  });

  it("replaces a streamed message with the host's authoritative text", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Stream a response",
    });

    harness.callbacks().onEvent({
      type: "message-update",
      conversationId: "new-session",
      messageId: "message-raw",
      role: "assistant",
      operation: "append",
      text: "Partial response",
    });
    harness.callbacks().onEvent({
      type: "message-update",
      conversationId: "new-session",
      messageId: "message-raw",
      role: "assistant",
      operation: "replace",
      text: "Authoritative response",
    });

    expect(
      harness.controller.state.entries.filter(
        (entry) => entry.type === "message" && entry.role === "assistant",
      ),
    ).toEqual([expect.objectContaining({ body: "Authoritative response" })]);
  });

  it("redacts local paths in web URL query and fragment values", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Inspect URL paths",
    });

    harness
      .callbacks()
      .onEvent(
        textUpdate(
          "new-session",
          "agent_message_chunk",
          [
            "Normal https://example.test/docs/path?q=hello#section",
            `workspace https://example.test/open?path=${WORKSPACE}/src/index.ts`,
            "outside https://example.test/open?path=/home/alice/private.txt#file=~/secret.txt",
            "encoded https://example.test/open?path=%2Fhome%2Falice%2Fencoded.txt",
            "session https://example.test/open?session=%6E%65%77%2D%73%65%73%73%69%6F%6E#again=%6E%65%77%2D%73%65%73%73%69%6F%6E",
          ].join(" | "),
          "url-paths",
        ),
      );

    expect(harness.controller.state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          body: [
            "Normal https://example.test/docs/path?q=hello#section",
            "workspace https://example.test/open?path=./src/index.ts",
            "outside https://example.test/open?path=[path]#file=[path]",
            "encoded https://example.test/open?path=%5Bpath%5D",
            "session https://example.test/open?session=%5Bsession%5D#again=%5Bsession%5D",
          ].join(" | "),
        }),
      ]),
    );
    const serialized = JSON.stringify(harness.controller.state);
    expect(serialized).not.toContain(WORKSPACE);
    expect(serialized).not.toContain("%6E%65%77%2D%73%65%73%73%69%6F%6E");
    expect(serialized).not.toContain("new-session");
    expect(serialized).not.toMatch(/home|alice|private\.txt|encoded\.txt|secret\.txt/u);

    harness.host.promptGate.resolve(undefined);
    await flushPromises();
  });

  it("fully redacts workspace-prefix sibling paths from messages, tools, and permissions", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Inspect an outside path",
    });
    const callbacks = harness.callbacks();
    const siblingPath = `${WORKSPACE}-backup/private.txt`;
    const containingPath = `/outside${WORKSPACE}/private.txt`;
    const dotContainingPath = `.${WORKSPACE}/private.txt`;
    const dotPairContainingPath = `..${WORKSPACE}/private.txt`;
    const schemeContainingPath = `scheme:${WORKSPACE}/private.txt`;
    const alternateWorkspace = WORKSPACE.replaceAll("/", "\\");
    const alternateSiblingPath = `${alternateWorkspace}-backup\\private.txt`;
    const traversalPath = `${WORKSPACE}/../outside-secret.txt`;
    const nestedTraversalPath = `${WORKSPACE}/src/../../outside-secret.txt`;
    const alternateTraversalPath = `${alternateWorkspace}\\..\\outside-secret.txt`;

    callbacks.onEvent(
      textUpdate("new-session", "agent_message_chunk", `Opened ${siblingPath}`, "sibling-path"),
    );
    callbacks.onEvent(
      textUpdate(
        "new-session",
        "agent_message_chunk",
        `Opened ${containingPath}`,
        "containing-path",
      ),
    );
    for (const [messageId, outsidePath] of [
      ["dot-containing-path", dotContainingPath],
      ["dot-pair-containing-path", dotPairContainingPath],
      ["scheme-containing-path", schemeContainingPath],
      ["traversal-path", traversalPath],
      ["nested-traversal-path", nestedTraversalPath],
      ["alternate-traversal-path", alternateTraversalPath],
    ] as const) {
      callbacks.onEvent(
        textUpdate("new-session", "agent_message_chunk", `Opened ${outsidePath}`, messageId),
      );
    }
    callbacks.onEvent(
      textUpdate(
        "new-session",
        "agent_message_chunk",
        `Workspace ${alternateWorkspace}`,
        "alternate-exact-path",
      ),
    );
    callbacks.onEvent(
      textUpdate(
        "new-session",
        "agent_message_chunk",
        `Opened ${alternateWorkspace}\\src\\index.ts`,
        "alternate-descendant-path",
      ),
    );
    callbacks.onEvent(
      textUpdate(
        "new-session",
        "agent_message_chunk",
        `Opened ${alternateSiblingPath}`,
        "alternate-sibling-path",
      ),
    );
    callbacks.onEvent({
      type: "tool-update",
      conversationId: "new-session",
      isCreation: true,
      tool: {
        id: "sibling-tool",
        title: `Read ${siblingPath}`,
        kind: "read",
        status: "pending",
      },
    });

    expect(harness.controller.state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", body: "Opened [path]" }),
        expect.objectContaining({ role: "assistant", body: "Workspace ." }),
        expect.objectContaining({ role: "assistant", body: "Opened .\\src\\index.ts" }),
        expect.objectContaining({ type: "tool", title: "Read [path]" }),
      ]),
    );
    expect(
      harness.controller.state.entries.filter(
        (entry) => entry.type === "message" && entry.body === "Opened [path]",
      ),
    ).toHaveLength(8);
    expect(harness.controller.state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", body: "Opened scheme:[path]" }),
      ]),
    );

    const abortController = new AbortController();
    const permission = callbacks.requestPermission(
      {
        conversationId: "new-session",
        tool: {
          id: "sibling-tool",
          title: `Edit ${alternateSiblingPath}`,
          kind: "edit",
          status: "pending",
        },
        options: [
          {
            id: "allow-sibling-tool",
            name: `Allow ${alternateSiblingPath} once`,
            kind: "allow_once",
          },
        ],
      },
      abortController.signal,
    );
    await flushPromises();

    expect(harness.controller.state.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool", title: "Edit [path]" })]),
    );
    expect(harness.controller.state.permissionRequest).toMatchObject({
      title: "Edit [path]",
      options: [expect.objectContaining({ name: "Allow [path] once" })],
    });
    expect(JSON.stringify(harness.controller.state)).not.toContain(`${WORKSPACE}-backup`);
    expect(JSON.stringify(harness.controller.state)).not.toContain(containingPath);
    expect(JSON.stringify(harness.controller.state)).not.toContain(dotContainingPath);
    expect(JSON.stringify(harness.controller.state)).not.toContain(dotPairContainingPath);
    expect(JSON.stringify(harness.controller.state)).not.toContain(schemeContainingPath);
    expect(JSON.stringify(harness.controller.state)).not.toContain("outside-secret.txt");
    expect(JSON.stringify(harness.controller.state)).not.toContain(".-backup");
    expect(JSON.stringify(harness.controller.state)).not.toContain(alternateSiblingPath);

    abortController.abort();
    await expect(permission).resolves.toEqual({ outcome: "cancelled" });
    harness.host.promptGate.resolve(undefined);
    await flushPromises();
  });

  it("keeps exact and descendant paths relative when the workspace is the filesystem root", async () => {
    const harness = createHarness({ workspacePath: "/", sessionId: null });
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Inspect root paths",
    });

    harness
      .callbacks()
      .onEvent(
        textUpdate(
          "new-session",
          "agent_message_chunk",
          "Workspace / and child /private/file.txt URL https://example.test/root/path",
        ),
      );
    harness
      .callbacks()
      .onEvent(
        textUpdate(
          "new-session",
          "agent_message_chunk",
          "Relative ./src/index.ts ../shared.ts .\\src\\index.ts ..\\shared.ts",
          "relative-paths",
        ),
      );

    expect(harness.controller.state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          body: "Workspace . and child ./private/file.txt URL https://example.test/root/path",
        }),
        expect.objectContaining({
          role: "assistant",
          body: "Relative ./src/index.ts ../shared.ts .\\src\\index.ts ..\\shared.ts",
        }),
      ]),
    );

    harness.host.promptGate.resolve(undefined);
    await flushPromises();
  });

  it("does not retry a rejected prompt and publishes a sanitized error", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Run once",
    });

    harness.host.promptGate.reject(new Error(`provider failed at ${WORKSPACE}/secret`));
    await flushPromises();

    expect(harness.host.promptCalls).toHaveLength(1);
    expect(harness.controller.state).toMatchObject({
      status: "error",
      error: "Claude Code stopped before completing the prompt.",
    });
    expect(JSON.stringify(harness.controller.state)).not.toContain(WORKSPACE);
    expect(harness.host.disposeCalls).toBe(1);
  });

  it("maps permission identifiers and returns only the selected host option", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Make a change",
    });
    const permission = harness
      .callbacks()
      .requestPermission(permissionRequest(), new AbortController().signal);
    await flushPromises();
    const request = harness.controller.state.permissionRequest;
    expect(request).not.toBeNull();
    if (request === null) throw new Error("Expected a permission request");
    expect(request.id).not.toBe("raw-tool-id");
    expect(request.toolCallId).not.toBe("raw-tool-id");
    expect(request.options.map((option) => option.id)).not.toContain("raw-allow");
    expect(request.options[0]?.name).toBe("Allow [session] once");
    expect(JSON.stringify(harness.controller.state)).not.toContain("new-session");

    await expect(
      harness.controller.respondPermission({
        generation: harness.controller.state.generation,
        requestId: "wrong-request",
        optionId: request.options[0]?.id ?? "missing",
      }),
    ).rejects.toThrow(/stale/);
    await expect(
      harness.controller.respondPermission({
        generation: harness.controller.state.generation,
        requestId: request.id,
        optionId: "wrong-option",
      }),
    ).rejects.toThrow(/not offered/);

    await harness.controller.respondPermission({
      generation: harness.controller.state.generation,
      requestId: request.id,
      optionId: request.options[0]?.id ?? "missing",
    });
    await expect(permission).resolves.toEqual({ outcome: "selected", optionId: "raw-allow" });
    expect(harness.controller.state.permissionRequest).toBeNull();
  });

  it("default-cancels permission, advances generation, and fences prompt completion on cancel", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    const staleCallbacks = harness.callbacks();
    const running = await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Needs permission",
    });
    const permission = harness
      .callbacks()
      .requestPermission(permissionRequest(), new AbortController().signal);
    await flushPromises();

    const cancelled = await harness.controller.cancelPrompt({
      generation: running.generation,
    });

    await expect(permission).resolves.toEqual({ outcome: "cancelled" });
    expect(cancelled).toMatchObject({
      generation: running.generation + 1,
      status: "configured",
      permissionRequest: null,
    });
    expect(harness.host.cancelCalls).toEqual(["new-session"]);
    expect(harness.host.disposeCalls).toBe(1);
    await expect(
      harness.controller.sendPrompt({ generation: running.generation, prompt: "stale" }),
    ).rejects.toThrow(/stale/);

    harness.host.promptGate.resolve(undefined);
    await flushPromises();
    expect(harness.controller.state).toEqual(cancelled);

    await harness.controller.start({ generation: cancelled.generation });
    harness.host.promptGate = deferred<void>();
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "New host turn",
    });
    const newTurnEntries = harness.controller.state.entries;
    staleCallbacks.onEvent(
      textUpdate("new-session", "agent_message_chunk", "late prior turn", "late-prior"),
    );
    await expect(
      staleCallbacks.requestPermission(permissionRequest(), new AbortController().signal),
    ).resolves.toEqual({ outcome: "cancelled" });
    expect(harness.controller.state.entries).toEqual(newTurnEntries);
    expect(harness.controller.state.permissionRequest).toBeNull();
  });

  it("keeps cancellation busy until host retirement and default-cancels late permissions", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    harness.host.cancelGate = deferred<void>();
    harness.host.disposeGate = deferred<void>();
    await startReady(harness);
    const callbacks = harness.callbacks();
    const running = await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Long task",
    });
    const entriesBeforeCancellation = harness.controller.state.entries;

    const cancellation = harness.controller.cancelPrompt({ generation: running.generation });

    expect(harness.controller.state).toMatchObject({
      generation: running.generation + 1,
      status: "running",
    });
    expect(harness.host.cancelCalls).toEqual(["new-session"]);
    expect(harness.host.disposeCalls).toBe(0);
    await expect(
      callbacks.requestPermission(permissionRequest(), new AbortController().signal),
    ).resolves.toEqual({ outcome: "cancelled" });
    callbacks.onEvent(
      textUpdate("new-session", "agent_message_chunk", "late stale output", "late"),
    );
    expect(harness.controller.state.entries).toEqual(entriesBeforeCancellation);
    await expect(
      harness.controller.sendPrompt({
        generation: harness.controller.state.generation,
        prompt: "must wait",
      }),
    ).rejects.toThrow(/not ready/);

    harness.host.promptGate.resolve(undefined);
    await flushPromises();
    expect(harness.controller.state.status).toBe("running");
    harness.host.cancelGate?.resolve(undefined);
    await flushPromises();
    expect(harness.host.closeCalls).toEqual(["new-session"]);
    expect(harness.host.disposeCalls).toBe(1);
    harness.host.disposeGate.resolve(undefined);
    await expect(cancellation).resolves.toMatchObject({ status: "configured" });
  });

  it("evicts stale tool identifier mappings with bounded transcript entries", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Run many tools",
    });
    const callbacks = harness.callbacks();

    for (let index = 0; index < 1_001; index += 1) {
      callbacks.onEvent({
        type: "tool-update",
        conversationId: "new-session",
        isCreation: true,
        tool: {
          id: `raw-tool-${String(index)}`,
          title: `Tool ${String(index)}`,
          kind: "read",
          status: "completed",
        },
      });
    }

    const permission = callbacks.requestPermission(
      {
        ...permissionRequest(),
        tool: {
          ...permissionRequest().tool,
          id: "raw-tool-after-eviction",
        },
      },
      new AbortController().signal,
    );
    await flushPromises();

    expect(harness.controller.state.permissionRequest).not.toBeNull();
    await harness.controller.cancelPrompt({
      generation: harness.controller.state.generation,
    });
    await expect(permission).resolves.toEqual({ outcome: "cancelled" });
  });

  it("keeps streamed message chunks joined after stale identifier mappings are evicted", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Stream many messages",
    });
    const callbacks = harness.callbacks();

    for (let index = 0; index < 1_001; index += 1) {
      callbacks.onEvent(
        textUpdate(
          "new-session",
          "agent_message_chunk",
          `Message ${String(index)}`,
          `raw-message-${String(index)}`,
        ),
      );
    }
    callbacks.onEvent(textUpdate("new-session", "agent_message_chunk", "Hello ", "after-eviction"));
    callbacks.onEvent(textUpdate("new-session", "agent_message_chunk", "world", "after-eviction"));

    expect(
      harness.controller.state.entries.filter(
        (entry) => entry.type === "message" && entry.body === "Hello world",
      ),
    ).toHaveLength(1);
  });

  it("fences a slow suspend so it cannot overwrite a newer start", async () => {
    const preferences = new FakePreferenceStore({ workspacePath: WORKSPACE, sessionId: null });
    const firstHost = new FakeHost();
    const secondHost = new FakeHost();
    const firstDisposal = deferred<void>();
    firstHost.disposeGate = firstDisposal;
    const hosts = [firstHost, secondHost];
    let factoryIndex = 0;
    const controller = new AiChannelController({
      preferenceStore: preferences,
      hostFactory: async () => {
        const host = hosts[factoryIndex];
        factoryIndex += 1;
        if (host === undefined) throw new Error("Unexpected host creation");
        return host;
      },
      now: () => NOW,
    });
    await controller.initialize();
    await controller.start({ generation: controller.state.generation });

    const suspension = controller.suspend();
    const restart = controller.start({ generation: controller.state.generation });
    expect(controller.state.status).toBe("starting");
    expect(factoryIndex).toBe(1);

    firstDisposal.resolve(undefined);
    await suspension;
    const restarted = await restart;

    expect(restarted.status).toBe("ready");
    expect(controller.state).toEqual(restarted);
    expect(factoryIndex).toBe(2);
    expect(firstHost.disposeCalls).toBe(1);
    expect(secondHost.disposeCalls).toBe(0);
  });

  it("starts a new session once, closes the old session, clears projection, and persists", async () => {
    const harness = createHarness();
    await startReady(harness);
    harness.host.nextConversationId = "second-session";
    const before = harness.controller.state;

    const state = await harness.controller.newSession({ generation: before.generation });

    expect(state).toMatchObject({
      generation: before.generation + 1,
      status: "ready",
      entries: [],
      plan: [],
    });
    expect(harness.host.closeCalls).toEqual(["new-session"]);
    expect(harness.host.newConversationCalls).toEqual([WORKSPACE, WORKSPACE]);
    expect(harness.preferences.saves.at(-1)).toEqual({
      workspacePath: WORKSPACE,
      sessionId: "second-session",
    });
  });

  it("default-cancels on host exit, exposes no exit details, and ignores stale updates", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Needs permission",
    });
    const permission = harness
      .callbacks()
      .requestPermission(permissionRequest(), new AbortController().signal);
    await flushPromises();
    const generation = harness.controller.state.generation;

    harness.callbacks().onExit({ reason: "exited" });

    await expect(permission).resolves.toEqual({ outcome: "cancelled" });
    expect(harness.controller.state).toMatchObject({
      generation: generation + 1,
      status: "error",
      error: "Claude Code disconnected from this AI Channel.",
      permissionRequest: null,
    });
    expect(JSON.stringify(harness.controller.state)).not.toContain("137");
    const entries = harness.controller.state.entries;
    harness
      .callbacks()
      .onEvent(textUpdate("new-session", "agent_message_chunk", "late stale output", "late"));
    expect(harness.controller.state.entries).toEqual(entries);
  });

  it("suspends and disposes with cancellation, close, and host disposal", async () => {
    const harness = createHarness();
    harness.host.promptGate = deferred<void>();
    await startReady(harness);
    await harness.controller.sendPrompt({
      generation: harness.controller.state.generation,
      prompt: "Long task",
    });
    const permission = harness
      .callbacks()
      .requestPermission(permissionRequest(), new AbortController().signal);
    await flushPromises();

    const suspended = await harness.controller.suspend();

    await expect(permission).resolves.toEqual({ outcome: "cancelled" });
    expect(suspended).toMatchObject({ status: "configured", entries: [], plan: [] });
    expect(harness.host.cancelCalls).toEqual(["new-session"]);
    expect(harness.host.closeCalls).toEqual(["new-session"]);
    expect(harness.host.disposeCalls).toBe(1);

    const secondHarness = createHarness();
    secondHarness.host.promptGate = deferred<void>();
    await startReady(secondHarness);
    await secondHarness.controller.sendPrompt({
      generation: secondHarness.controller.state.generation,
      prompt: "Long task",
    });
    const disposePermission = secondHarness
      .callbacks()
      .requestPermission(permissionRequest(), new AbortController().signal);
    await flushPromises();
    await secondHarness.controller.dispose();

    await expect(disposePermission).resolves.toEqual({ outcome: "cancelled" });
    expect(secondHarness.host.cancelCalls).toEqual(["new-session"]);
    expect(secondHarness.host.closeCalls).toEqual(["new-session"]);
    expect(secondHarness.host.disposeCalls).toBe(1);
    expect(() => secondHarness.controller.state).toThrow(/disposed/);
  });

  it("bounds the curated transcript and isolates listener failures", async () => {
    const listenerErrors: unknown[] = [];
    const preferences = new FakePreferenceStore({ workspacePath: WORKSPACE, sessionId: null });
    const host = new FakeHost();
    host.promptGate = deferred<void>();
    const callbackCaptures: AiAgentHostCallbacks[] = [];
    const controller = new AiChannelController({
      preferenceStore: preferences,
      hostFactory: async (nextCallbacks) => {
        callbackCaptures.push(nextCallbacks);
        return host;
      },
      now: () => NOW,
      reportListenerError: (error) => listenerErrors.push(error),
    });
    await controller.initialize();
    const delivered: AiChannelState[] = [];
    const listenerError = new Error("renderer closed");
    controller.subscribe(() => {
      throw listenerError;
    });
    controller.subscribe((state) => delivered.push(state));
    await controller.start({ generation: controller.state.generation });
    await controller.sendPrompt({ generation: controller.state.generation, prompt: "Stream" });
    const callbacks = callbackCaptures[0];
    if (callbacks === undefined) throw new Error("Missing callbacks");

    for (let index = 0; index < 220; index += 1) {
      callbacks.onEvent(
        textUpdate(
          "new-session",
          "agent_message_chunk",
          "x".repeat(4_000),
          `message-${String(index)}`,
        ),
      );
    }

    expect(controller.state.entries.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(JSON.stringify(controller.state), "utf8")).toBeLessThan(1_048_576);
    expect(listenerErrors).toContain(listenerError);
    expect(delivered.at(-1)).toEqual(controller.state);
  });

  it("publishes unavailable without leaking factory failures", async () => {
    const preferences = new FakePreferenceStore({ workspacePath: WORKSPACE, sessionId: null });
    const controller = new AiChannelController({
      preferenceStore: preferences,
      hostFactory: async () => {
        throw new Error(`missing executable at ${WORKSPACE}/bin/claude`);
      },
      now: () => NOW,
    });
    await controller.initialize();

    const state = await controller.start({ generation: controller.state.generation });

    expect(state).toMatchObject({
      status: "unavailable",
      error: "Install Claude Code and make sure claude is available on PATH, then retry.",
    });
    expect(JSON.stringify(state)).not.toContain(WORKSPACE);
  });
});
