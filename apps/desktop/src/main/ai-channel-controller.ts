import path from "node:path";

import {
  aiChannelGenerationRequestSchema,
  aiChannelPermissionResponseSchema,
  aiChannelPromptRequestSchema,
  aiChannelStateSchema,
  type AiChannelEntry,
  type AiChannelGenerationRequest,
  type AiChannelMessage,
  type AiChannelPermissionOption,
  type AiChannelPermissionRequest,
  type AiChannelPermissionResponse,
  type AiChannelPlanEntry,
  type AiChannelPromptRequest,
  type AiChannelState,
  type AiChannelToolCall,
} from "@hype-comms/contracts";

import {
  AiAgentHostError,
  type AiAgentHost,
  type AiAgentHostEvent,
  type AiAgentHostExit,
  type AiAgentHostPermissionOutcome,
  type AiAgentHostPermissionRequest,
  type AiAgentHostTool,
  type CreateAiAgentHost,
} from "./ai-agent-host";
import type { AiChannelPreference, AiChannelPreferenceStore } from "./ai-channel-preference-store";

const MAX_ENTRIES = 200;
const MAX_PLAN_ENTRIES = 100;
const MAX_ENTRY_BYTES = 700_000;
const MAX_MESSAGE_BYTES = 100_000;
const MAX_AGENT_IDENTIFIER_LENGTH = 1_024;
const MAX_TRACKED_AGENT_IDENTIFIERS = 1_000;

type AiChannelPreferencePersistence = Pick<AiChannelPreferenceStore, "load" | "save">;
type StateListener = (state: AiChannelState) => void;

interface HostToken {
  readonly id: number;
}

interface ActivePrompt {
  readonly generation: number;
  readonly hostToken: HostToken;
  readonly conversationId: string;
}

interface PendingPermission {
  readonly generation: number;
  readonly requestId: string;
  readonly optionIds: ReadonlyMap<string, string>;
  readonly resolve: (response: AiAgentHostPermissionOutcome) => void;
  readonly removeAbortListener: () => void;
}

export interface AiChannelHostPresentation {
  readonly displayName: string;
  readonly executableName: string;
}

function isValidStoredSessionId(value: string | null): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !value.includes("\0")
  );
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.normalize(value) === value
  );
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const source = Buffer.from(value, "utf8");
  if (source.byteLength <= maximumBytes) return value;
  return source
    .subarray(0, maximumBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

function replaceAllLiteral(source: string, search: string, replacement: string): string {
  return search === "" ? source : source.split(search).join(replacement);
}

function pathTailContainsParentTraversal(source: string, offset: number): boolean {
  const pathTail = /^[^\s<>"'`]*/u.exec(source.slice(offset))?.[0] ?? "";
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(pathTail);
}

function replacePathAtBoundary(source: string, search: string, replacement: string): string {
  if (search === "") return source;

  const searchEndsWithSeparator = /[\\/]$/u.test(search);
  let result = "";
  let offset = 0;
  while (offset < source.length) {
    const matchOffset = source.indexOf(search, offset);
    if (matchOffset < 0) return result + source.slice(offset);

    const matchEnd = matchOffset + search.length;
    const preceding = source[matchOffset - 1];
    const following = source[matchEnd];
    const hasLeadingBoundary = preceding === undefined || !/[A-Za-z0-9_./\\:+~-]/u.test(preceding);
    const hasTrailingBoundary =
      searchEndsWithSeparator || following === undefined || following === "/" || following === "\\";
    if (
      hasLeadingBoundary &&
      hasTrailingBoundary &&
      !pathTailContainsParentTraversal(source, matchEnd)
    ) {
      const retainedSeparator =
        searchEndsWithSeparator && following !== undefined && !/[\s<>"'`]/u.test(following)
          ? search.at(-1)
          : "";
      result += source.slice(offset, matchOffset) + replacement + retainedSeparator;
    } else {
      result += source.slice(offset, matchEnd);
    }
    offset = matchEnd;
  }
  return result;
}

function replaceUnsafeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe =
      codePoint <= 8 ||
      (codePoint >= 11 && codePoint <= 12) ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127;
    return unsafe ? " " : character;
  }).join("");
}

function isUnreplacedWorkspacePath(candidate: string, workspacePath: string | null): boolean {
  if (workspacePath === null) return false;
  const variants = new Set([
    workspacePath,
    path.sep === "/" ? workspacePath.replaceAll("/", "\\") : workspacePath.replaceAll("\\", "/"),
  ]);
  return [...variants].some((variant) => {
    // Exact and descendant root paths have already been marked. Treating every remaining rooted
    // candidate as a match would incorrectly redact ordinary ./ and ../ relative paths.
    if (variant === "/" || variant === "\\") return false;
    return (
      candidate === variant ||
      candidate.startsWith(`${variant}/`) ||
      candidate.startsWith(`${variant}\\`)
    );
  });
}

function sanitizeUrlValue(
  value: string,
  workspacePath: string | null,
  sensitiveValues: readonly string[],
): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed percent escapes stay literal and still pass through display sanitization.
  }

  const sanitized = /^https?:\/\//iu.test(decoded)
    ? sanitizeWebUrl(decoded, workspacePath, sensitiveValues)
    : sanitizeDisplayText(decoded, workspacePath, Number.MAX_SAFE_INTEGER, sensitiveValues);
  if (sanitized === decoded) return value;
  return decoded === value ? sanitized : encodeURIComponent(sanitized);
}

function sanitizeUrlParameters(
  value: string,
  workspacePath: string | null,
  sensitiveValues: readonly string[],
): string {
  return value
    .split("&")
    .map((parameter) => {
      const separator = parameter.indexOf("=");
      if (separator < 0) return sanitizeUrlValue(parameter, workspacePath, sensitiveValues);
      return `${parameter.slice(0, separator + 1)}${sanitizeUrlValue(
        parameter.slice(separator + 1),
        workspacePath,
        sensitiveValues,
      )}`;
    })
    .join("&");
}

function sanitizeWebUrl(
  value: string,
  workspacePath: string | null,
  sensitiveValues: readonly string[],
): string {
  const fragmentOffset = value.indexOf("#");
  const beforeFragment = fragmentOffset < 0 ? value : value.slice(0, fragmentOffset);
  const fragment = fragmentOffset < 0 ? null : value.slice(fragmentOffset + 1);
  const queryOffset = beforeFragment.indexOf("?");
  const base = queryOffset < 0 ? beforeFragment : beforeFragment.slice(0, queryOffset);
  const query = queryOffset < 0 ? null : beforeFragment.slice(queryOffset + 1);

  return (
    base +
    (query === null ? "" : `?${sanitizeUrlParameters(query, workspacePath, sensitiveValues)}`) +
    (fragment === null ? "" : `#${sanitizeUrlParameters(fragment, workspacePath, sensitiveValues)}`)
  );
}

function sanitizeDisplayText(
  value: string,
  workspacePath: string | null,
  maximumBytes: number,
  sensitiveValues: readonly string[] = [],
): string {
  let result = replaceUnsafeControlCharacters(value);
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue !== "") result = replaceAllLiteral(result, sensitiveValue, "[session]");
  }

  // Temporarily remove web URLs so their path separators are not mistaken for local paths.
  const webUrls: string[] = [];
  result = result.replace(/\bhttps?:\/\/[^\s<>"']+/giu, (url) => {
    const index = webUrls.push(sanitizeWebUrl(url, workspacePath, sensitiveValues)) - 1;
    return `\uE000${String(index)}\uE001`;
  });

  // The trailing underscore keeps a workspace-relative suffix out of absolute-path matching.
  const workspaceMarker = "\uE100\uE101_";
  if (workspacePath !== null) {
    result = replacePathAtBoundary(result, workspacePath, workspaceMarker);
    const alternateSeparatorPath =
      path.sep === "/" ? workspacePath.replaceAll("/", "\\") : workspacePath.replaceAll("\\", "/");
    result = replacePathAtBoundary(result, alternateSeparatorPath, workspaceMarker);
  }

  // ACP text is untrusted display data. Redact filesystem-shaped values after any punctuation.
  result = result
    .replace(
      /(["'])(?:(?:file:\/\/)|(?:\\\\)|(?:[A-Za-z]:[\\/])|(?:~[\\/])|\/)[^"'\r\n]*\1/giu,
      "$1[path]$1",
    )
    .replace(/file:\/\/[^\s<>"']+/giu, "[path]")
    .replace(/\\\\[^\s<>"']+/gu, "[path]")
    .replace(/\b[A-Za-z]:[\\/][^\s<>"']+/gu, "[path]")
    .replace(
      /(?:\.\.?)?\\(?:[^\\\s<>"'`]+\\)*[^\\\s<>"'`]*/gu,
      (candidate, offset: number, source: string) => {
        const preceding = source[offset - 1];
        if (preceding !== undefined && /[A-Za-z0-9_/\\+~-]/u.test(preceding)) return candidate;
        const separatorOffset = candidate.startsWith("..\\")
          ? 2
          : candidate.startsWith(".\\")
            ? 1
            : 0;
        const rootedCandidate = candidate.slice(separatorOffset);
        return separatorOffset > 0 && !isUnreplacedWorkspacePath(rootedCandidate, workspacePath)
          ? candidate
          : "[path]";
      },
    )
    .replace(/(^|[\s([{'"])~[\\/][^\s<>"']+/gmu, "$1[path]")
    .replace(
      /(?:\.\.?)?\/(?:[^/\s<>"'`]+\/)*[^/\s<>"'`]*/gu,
      (candidate, offset: number, source: string) => {
        const preceding = source[offset - 1];
        if (preceding !== undefined && /[A-Za-z0-9_/+~-]/u.test(preceding)) return candidate;
        const separatorOffset = candidate.startsWith("../")
          ? 2
          : candidate.startsWith("./")
            ? 1
            : 0;
        const rootedCandidate = candidate.slice(separatorOffset);
        return separatorOffset > 0 && !isUnreplacedWorkspacePath(rootedCandidate, workspacePath)
          ? candidate
          : "[path]";
      },
    );
  for (const [index, url] of webUrls.entries()) {
    result = replaceAllLiteral(result, `\uE000${String(index)}\uE001`, url);
  }
  result = replaceAllLiteral(result, workspaceMarker, ".");
  return truncateUtf8(result, maximumBytes);
}

function sanitizeLabel(
  value: string | null | undefined,
  fallback: string,
  workspacePath: string | null,
  maximumBytes: number,
  sensitiveValues: readonly string[] = [],
): string {
  const sanitized = sanitizeDisplayText(value ?? "", workspacePath, maximumBytes, sensitiveValues)
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized === "" ? fallback : sanitized;
}

function workspaceDisplayName(workspacePath: string): string {
  return sanitizeLabel(path.basename(workspacePath), "Workspace", null, 255);
}

function isAgentIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_AGENT_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !value.includes("\0")
  );
}

function initialState(preference: AiChannelPreference): AiChannelState {
  return {
    version: 1,
    generation: 1,
    status: preference.workspacePath === null ? "not-configured" : "configured",
    workspaceName:
      preference.workspacePath === null ? null : workspaceDisplayName(preference.workspacePath),
    entries: [],
    plan: [],
    permissionRequest: null,
    error: null,
  };
}

/**
 * Owns the device-local AI agent lifecycle. The renderer receives only the bounded projection in
 * AiChannelState; workspace paths, conversation IDs, provider payloads, and diagnostics stay here.
 */
export class AiChannelController {
  readonly #preferenceStore: AiChannelPreferencePersistence;
  readonly #hostFactory: CreateAiAgentHost;
  readonly #hostDisplayName: string;
  readonly #hostExecutableName: string;
  readonly #now: () => Date;
  readonly #reportListenerError: (error: unknown) => void;
  readonly #listeners = new Set<StateListener>();
  readonly #messageIds = new Map<string, string>();
  readonly #messageBodies = new Map<string, string>();
  readonly #toolIds = new Map<string, string>();

  #preference: AiChannelPreference = { workspacePath: null, sessionId: null };
  #state: AiChannelState | null = null;
  #initialization: Promise<AiChannelState> | null = null;
  #host: AiAgentHost | null = null;
  #hostToken: HostToken | null = null;
  #acceptedSessionId: string | null = null;
  #activePrompt: ActivePrompt | null = null;
  #pendingPermission: PendingPermission | null = null;
  #nextIdentifier = 1;
  #nextHostToken = 1;
  #lifecycleOperation = 0;
  #hostRetirement: Promise<void> | null = null;
  #disposed = false;

  constructor(options: {
    readonly preferenceStore: AiChannelPreferencePersistence;
    readonly hostFactory: CreateAiAgentHost;
    readonly hostPresentation: AiChannelHostPresentation;
    readonly now?: () => Date;
    readonly reportListenerError?: (error: unknown) => void;
  }) {
    this.#preferenceStore = options.preferenceStore;
    this.#hostFactory = options.hostFactory;
    this.#hostDisplayName = sanitizeLabel(
      options.hostPresentation.displayName,
      "AI assistant",
      null,
      100,
    );
    this.#hostExecutableName = sanitizeLabel(
      options.hostPresentation.executableName,
      "AI assistant executable",
      null,
      100,
    );
    this.#now = options.now ?? (() => new Date());
    this.#reportListenerError =
      options.reportListenerError ??
      (() => {
        // Listener failures can carry a rejected state payload. Never write that payload to logs.
        console.error("AI Channel state listener failed");
      });
  }

  get state(): AiChannelState {
    return this.#requireState();
  }

  initialize(): Promise<AiChannelState> {
    if (this.#disposed) {
      return Promise.reject(new Error("AiChannelController has been disposed"));
    }
    if (this.#state !== null) return Promise.resolve(this.#state);
    if (this.#initialization !== null) return this.#initialization;

    const initialization = this.#initialize();
    this.#initialization = initialization;
    void initialization.catch(() => {
      if (this.#initialization === initialization) this.#initialization = null;
    });
    return initialization;
  }

  subscribe(listener: StateListener): () => void {
    this.#assertReady();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(input: AiChannelGenerationRequest): Promise<AiChannelState> {
    const request = aiChannelGenerationRequestSchema.parse(input);
    this.#assertGeneration(request.generation);
    const state = this.#requireState();
    if (state.status === "running" || state.status === "starting") {
      throw new Error("AI Channel is already busy");
    }
    if (state.status === "ready" && this.#host !== null && this.#acceptedSessionId !== null) {
      return state;
    }
    if (this.#preference.workspacePath === null) {
      throw new Error("Choose an AI Channel workspace first");
    }

    const lifecycleOperation = this.#beginLifecycleOperation();
    this.#clearConversation();
    this.#replaceState({ status: "starting", entries: [], plan: [], error: null });
    let existingRetirement = this.#hostRetirement;
    while (existingRetirement !== null) {
      await existingRetirement;
      existingRetirement = this.#hostRetirement;
    }
    if (!this.#isCurrentLifecycleOperation(lifecycleOperation)) return this.#requireState();
    const hostToken = this.#newHostToken();
    let host: AiAgentHost;
    try {
      host = await this.#hostFactory({
        onEvent: (event) => this.#handleHostEvent(hostToken, event),
        requestPermission: (requestPermission, signal) =>
          this.#handlePermissionRequest(hostToken, requestPermission, signal),
        onExit: (event) => this.#handleHostExit(hostToken, event),
      });
    } catch (error) {
      if (
        this.#isCurrentLifecycleOperation(lifecycleOperation) &&
        this.#isCurrentHostToken(hostToken)
      ) {
        this.#hostToken = null;
        this.#replaceState({
          status: "unavailable",
          error: this.#hostFailureMessage(
            error,
            `Install ${this.#hostDisplayName} and make sure ${this.#hostExecutableName} is available on PATH, then retry.`,
          ),
        });
      }
      return this.#requireState();
    }

    if (
      !this.#isCurrentLifecycleOperation(lifecycleOperation) ||
      !this.#isCurrentHostToken(hostToken)
    ) {
      await this.#disposeHostBestEffort(host);
      return this.#requireState();
    }
    this.#host = host;

    try {
      const sessionId = await this.#loadOrCreateSession(hostToken, host);
      if (sessionId === null) return this.#requireState();
      if (!this.#isCurrentLifecycleOperation(lifecycleOperation)) return this.#requireState();
      this.#acceptedSessionId = sessionId;
      this.#replaceState({ status: "ready", error: null });
    } catch (error) {
      if (
        this.#isCurrentLifecycleOperation(lifecycleOperation) &&
        this.#isCurrentHostToken(hostToken)
      ) {
        await this.#failCurrentHost(
          hostToken,
          this.#hostFailureMessage(
            error,
            `${this.#hostDisplayName} could not open the selected workspace. Check ${this.#hostDisplayName} sign-in and folder access, then retry.`,
          ),
          lifecycleOperation,
        );
      }
    }
    return this.#requireState();
  }

  async chooseWorkspace(canonicalAbsolutePath: string): Promise<AiChannelState> {
    this.#assertReady();
    if (!isCanonicalAbsolutePath(canonicalAbsolutePath)) {
      throw new Error("AI Channel workspace must be a canonical absolute path");
    }

    const lifecycleOperation = this.#beginLifecycleOperation();
    const generation = this.#nextGeneration();
    await this.#retireHost();
    if (!this.#isCurrentLifecycleOperation(lifecycleOperation)) return this.#requireState();
    const preference: AiChannelPreference = {
      workspacePath: canonicalAbsolutePath,
      sessionId: null,
    };
    try {
      await this.#preferenceStore.save(preference);
      if (!this.#isCurrentLifecycleOperation(lifecycleOperation)) return this.#requireState();
    } catch {
      if (!this.#isCurrentLifecycleOperation(lifecycleOperation)) return this.#requireState();
      this.#replaceState({
        generation,
        status: this.#preference.workspacePath === null ? "not-configured" : "error",
        permissionRequest: null,
        error: "The AI Channel workspace preference could not be saved.",
      });
      throw new Error("The AI Channel workspace preference could not be saved");
    }

    this.#preference = preference;
    this.#clearConversation();
    return this.#replaceState({
      generation,
      status: "configured",
      workspaceName: workspaceDisplayName(canonicalAbsolutePath),
      entries: [],
      plan: [],
      permissionRequest: null,
      error: null,
    });
  }

  async newSession(input: AiChannelGenerationRequest): Promise<AiChannelState> {
    const request = aiChannelGenerationRequestSchema.parse(input);
    this.#assertGeneration(request.generation);
    const host = this.#host;
    const hostToken = this.#hostToken;
    const oldSessionId = this.#acceptedSessionId;
    const workspacePath = this.#preference.workspacePath;
    if (
      this.#requireState().status !== "ready" ||
      host === null ||
      hostToken === null ||
      oldSessionId === null ||
      workspacePath === null
    ) {
      throw new Error("AI Channel is not ready for a new session");
    }

    const generation = this.#nextGeneration();
    const lifecycleOperation = this.#beginLifecycleOperation();
    this.#settlePermission({ outcome: "cancelled" }, false);
    this.#activePrompt = null;
    this.#acceptedSessionId = null;
    this.#clearConversation();
    this.#replaceState({
      generation,
      status: "starting",
      entries: [],
      plan: [],
      permissionRequest: null,
      error: null,
    });

    try {
      await host.close(oldSessionId);
      if (
        !this.#isCurrentLifecycleOperation(lifecycleOperation) ||
        !this.#isCurrentHostToken(hostToken)
      ) {
        return this.#requireState();
      }
      const response = await host.newConversation(workspacePath);
      if (
        !this.#isCurrentLifecycleOperation(lifecycleOperation) ||
        !this.#isCurrentHostToken(hostToken)
      ) {
        return this.#requireState();
      }
      if (!isValidStoredSessionId(response.conversationId)) {
        throw new Error("Invalid AI agent conversation identifier");
      }
      const preference: AiChannelPreference = {
        workspacePath,
        sessionId: response.conversationId,
      };
      this.#acceptedSessionId = response.conversationId;
      await this.#preferenceStore.save(preference);
      if (
        !this.#isCurrentLifecycleOperation(lifecycleOperation) ||
        !this.#isCurrentHostToken(hostToken)
      ) {
        return this.#requireState();
      }
      this.#preference = preference;
      return this.#replaceState({ status: "ready", error: null });
    } catch (error) {
      if (
        this.#isCurrentLifecycleOperation(lifecycleOperation) &&
        this.#isCurrentHostToken(hostToken)
      ) {
        await this.#failCurrentHost(
          hostToken,
          this.#hostFailureMessage(
            error,
            `${this.#hostDisplayName} could not start a new session.`,
          ),
          lifecycleOperation,
        );
      }
      return this.#requireState();
    }
  }

  async sendPrompt(input: AiChannelPromptRequest): Promise<AiChannelState> {
    const request = aiChannelPromptRequestSchema.parse(input);
    this.#assertGeneration(request.generation);
    const state = this.#requireState();
    const host = this.#host;
    const hostToken = this.#hostToken;
    const sessionId = this.#acceptedSessionId;
    if (
      state.status !== "ready" ||
      host === null ||
      hostToken === null ||
      sessionId === null ||
      this.#activePrompt !== null
    ) {
      throw new Error("AI Channel is not ready for another prompt");
    }

    const activePrompt: ActivePrompt = {
      generation: state.generation,
      hostToken,
      conversationId: sessionId,
    };
    this.#activePrompt = activePrompt;
    this.#messageIds.delete("assistant:anonymous");
    this.#messageIds.delete("thought:anonymous");
    this.#messageBodies.delete("assistant:anonymous");
    this.#messageBodies.delete("thought:anonymous");
    const body = sanitizeDisplayText(
      request.prompt,
      this.#preference.workspacePath,
      MAX_MESSAGE_BYTES,
      [sessionId],
    );
    const userMessage: AiChannelMessage = {
      type: "message",
      id: this.#createIdentifier("message"),
      role: "user",
      body,
      createdAt: this.#timestamp(),
    };
    this.#replaceState({
      status: "running",
      entries: this.#boundEntries([...state.entries, userMessage]),
      permissionRequest: null,
      error: null,
    });

    let prompt: Promise<unknown>;
    try {
      prompt = host.prompt(sessionId, request.prompt);
    } catch (error) {
      void this.#finishPrompt(activePrompt, false, error);
      return this.#requireState();
    }
    void prompt.then(
      () => this.#finishPrompt(activePrompt, true),
      (error: unknown) => this.#finishPrompt(activePrompt, false, error),
    );
    return this.#requireState();
  }

  async cancelPrompt(input: AiChannelGenerationRequest): Promise<AiChannelState> {
    const request = aiChannelGenerationRequestSchema.parse(input);
    this.#assertGeneration(request.generation);
    const activePrompt = this.#activePrompt;
    const host = this.#host;
    if (this.#requireState().status !== "running" || activePrompt === null || host === null) {
      throw new Error("AI Channel has no prompt to cancel");
    }

    const lifecycleOperation = this.#beginLifecycleOperation();
    this.#settlePermission({ outcome: "cancelled" }, false);
    const generation = this.#nextGeneration();
    this.#activePrompt = null;
    this.#acceptedSessionId = null;
    this.#host = null;
    this.#hostToken = null;
    this.#replaceState({ generation, status: "running", permissionRequest: null, error: null });

    // Deliver bounded cancellation and conversation teardown before disposal. An agent host can
    // launch tools as child processes, so killing only the worker is not a sufficient stop signal,
    // while close lets the adapter abort and release its live turn explicitly.
    const retirement = this.#trackHostRetirement(
      this.#retireDetachedHost(host, activePrompt.conversationId, activePrompt),
    );
    await retirement;
    if (!this.#isCurrentLifecycleOperation(lifecycleOperation)) return this.#requireState();
    return this.#replaceState({ status: "configured", permissionRequest: null, error: null });
  }

  async respondPermission(input: AiChannelPermissionResponse): Promise<AiChannelState> {
    const response = aiChannelPermissionResponseSchema.parse(input);
    this.#assertGeneration(response.generation);
    const pending = this.#pendingPermission;
    if (
      pending === null ||
      pending.generation !== response.generation ||
      pending.requestId !== response.requestId
    ) {
      throw new Error("AI Channel permission request is stale");
    }
    const rawOptionId = pending.optionIds.get(response.optionId);
    if (rawOptionId === undefined) {
      throw new Error("AI Channel permission option was not offered");
    }
    this.#settlePermission({ outcome: "selected", optionId: rawOptionId }, true);
    return this.#requireState();
  }

  async suspend(): Promise<AiChannelState> {
    this.#assertReady();
    const lifecycleOperation = this.#beginLifecycleOperation();
    const generation = this.#nextGeneration();
    await this.#retireHost();
    if (!this.#isCurrentLifecycleOperation(lifecycleOperation)) return this.#requireState();
    this.#clearConversation();
    return this.#replaceState({
      generation,
      status: this.#preference.workspacePath === null ? "not-configured" : "configured",
      entries: [],
      plan: [],
      permissionRequest: null,
      error: null,
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#beginLifecycleOperation();
    this.#disposed = true;
    await this.#retireHost();
    this.#listeners.clear();
  }

  async #initialize(): Promise<AiChannelState> {
    let loaded: AiChannelPreference;
    try {
      loaded = await this.#preferenceStore.load();
    } catch {
      if (this.#disposed) throw new Error("AiChannelController has been disposed");
      this.#preference = { workspacePath: null, sessionId: null };
      this.#state = aiChannelStateSchema.parse({
        ...initialState(this.#preference),
        status: "unavailable",
        error: "AI Channel preferences could not be loaded on this device.",
      });
      return this.#state;
    }
    if (this.#disposed) throw new Error("AiChannelController has been disposed");
    const workspacePath =
      loaded.workspacePath !== null && isCanonicalAbsolutePath(loaded.workspacePath)
        ? loaded.workspacePath
        : null;
    this.#preference = {
      workspacePath,
      sessionId:
        workspacePath !== null && isValidStoredSessionId(loaded.sessionId)
          ? loaded.sessionId
          : null,
    };
    this.#state = aiChannelStateSchema.parse(initialState(this.#preference));
    return this.#state;
  }

  #newHostToken(): HostToken {
    const token = { id: this.#nextHostToken };
    this.#nextHostToken += 1;
    this.#hostToken = token;
    this.#acceptedSessionId = null;
    return token;
  }

  async #loadOrCreateSession(hostToken: HostToken, host: AiAgentHost): Promise<string | null> {
    const workspacePath = this.#preference.workspacePath;
    if (workspacePath === null) throw new Error("Missing AI Channel workspace");
    let sessionId = this.#preference.sessionId;

    if (sessionId !== null) {
      this.#acceptedSessionId = sessionId;
      try {
        await host.resumeConversation(workspacePath, sessionId);
        if (!this.#isCurrentHostToken(hostToken)) return null;
      } catch (error) {
        if (!this.#isCurrentHostToken(hostToken)) return null;
        if (!(error instanceof AiAgentHostError) || error.code !== "conversation-not-found") {
          throw error;
        }
        this.#acceptedSessionId = null;
        sessionId = null;
        this.#clearConversation();
        this.#replaceState({ entries: [], plan: [] });
      }
    }

    if (sessionId === null) {
      const response = await host.newConversation(workspacePath);
      if (!this.#isCurrentHostToken(hostToken)) return null;
      if (!isValidStoredSessionId(response.conversationId)) {
        throw new Error("Invalid AI agent conversation identifier");
      }
      sessionId = response.conversationId;
      this.#acceptedSessionId = sessionId;
    }

    const preference: AiChannelPreference = { workspacePath, sessionId };
    await this.#preferenceStore.save(preference);
    if (!this.#isCurrentHostToken(hostToken)) return null;
    this.#preference = preference;
    return sessionId;
  }

  #handleHostEvent(hostToken: HostToken, event: AiAgentHostEvent): void {
    if (!this.#isCurrentHostToken(hostToken) || event.conversationId !== this.#acceptedSessionId) {
      return;
    }
    const state = this.#state;
    const activePrompt = this.#activePrompt;
    const acceptsActivePrompt =
      activePrompt !== null &&
      activePrompt.hostToken === hostToken &&
      activePrompt.generation === state?.generation;
    if (state === null || (state.status !== "starting" && !acceptsActivePrompt)) return;

    switch (event.type) {
      case "message-update":
        if (event.role === "user" && state.status !== "starting") return;
        this.#applyMessageUpdate(event);
        return;
      case "tool-update":
        this.#applyToolUpdate(event.tool, event.isCreation);
        return;
      case "plan-replace":
        this.#replacePlan(event.entries);
        return;
      case "plan-remove":
        this.#replaceState({ plan: [] });
        return;
    }
  }

  #applyMessageUpdate(update: Extract<AiAgentHostEvent, { type: "message-update" }>): void {
    if (update.text === "") return;
    const rawMessageId = update.messageId;
    const role = update.role;
    const messageKey =
      typeof rawMessageId === "string" && isAgentIdentifier(rawMessageId)
        ? `${role}:${rawMessageId}`
        : `${role}:anonymous`;
    let publicId = this.#messageIds.get(messageKey);
    const state = this.#requireState();
    const entryIndex =
      publicId === undefined
        ? -1
        : state.entries.findIndex((entry) => entry.type === "message" && entry.id === publicId);
    const priorEntry = entryIndex < 0 ? null : state.entries[entryIndex];
    const priorRawBody =
      entryIndex < 0
        ? ""
        : (this.#messageBodies.get(messageKey) ??
          (priorEntry?.type === "message" ? priorEntry.body : ""));
    const rawBody = truncateUtf8(
      update.operation === "append" ? `${priorRawBody}${update.text}` : update.text,
      MAX_MESSAGE_BYTES,
    );
    const body = sanitizeDisplayText(
      rawBody,
      this.#preference.workspacePath,
      MAX_MESSAGE_BYTES,
      this.#acceptedSessionId === null ? [] : [this.#acceptedSessionId],
    );
    if (body === "") return;
    if (entryIndex < 0) {
      if (publicId === undefined && this.#messageIds.size < MAX_TRACKED_AGENT_IDENTIFIERS) {
        publicId = this.#createIdentifier("message");
        this.#messageIds.set(messageKey, publicId);
      }
      publicId ??= this.#createIdentifier("message");
      if (this.#messageIds.get(messageKey) === publicId) {
        this.#messageBodies.set(messageKey, rawBody);
      }
      const message: AiChannelMessage = {
        type: "message",
        id: publicId,
        role,
        body,
        createdAt: this.#timestamp(),
      };
      this.#replaceState({ entries: this.#boundEntries([...state.entries, message]) });
      return;
    }

    const current = state.entries[entryIndex];
    if (current === undefined || current.type !== "message") return;
    this.#messageBodies.set(messageKey, rawBody);
    const message: AiChannelMessage = {
      ...current,
      body,
    };
    const entries = [...state.entries];
    entries[entryIndex] = message;
    this.#replaceState({ entries: this.#boundEntries(entries) });
  }

  #applyToolUpdate(update: AiAgentHostTool, isCreation: boolean): void {
    if (!isAgentIdentifier(update.id)) return;
    let publicId = this.#toolIds.get(update.id);
    if (publicId === undefined) {
      if (this.#toolIds.size >= MAX_TRACKED_AGENT_IDENTIFIERS) return;
      publicId = this.#createIdentifier("tool");
      this.#toolIds.set(update.id, publicId);
    }

    const state = this.#requireState();
    const entryIndex = state.entries.findIndex(
      (entry) => entry.type === "tool" && entry.id === publicId,
    );
    const current = entryIndex < 0 ? null : state.entries[entryIndex];
    const currentTool = current?.type === "tool" ? current : null;
    const title =
      update.title === null || update.title === undefined
        ? (currentTool?.title ?? `${this.#hostDisplayName} tool`)
        : sanitizeLabel(
            update.title,
            `${this.#hostDisplayName} tool`,
            this.#preference.workspacePath,
            500,
            this.#acceptedSessionId === null ? [] : [this.#acceptedSessionId],
          );
    const kind = update.kind ?? currentTool?.kind ?? "other";
    const status =
      update.status === "declined"
        ? "failed"
        : (update.status ?? currentTool?.status ?? (isCreation ? "pending" : "in_progress"));
    const locations =
      update.locations === null || update.locations === undefined
        ? (currentTool?.locations ?? [])
        : update.locations
            .slice(0, 20)
            .map((location) => this.#sanitizeLocation(location.path, location.line))
            .filter((location): location is string => location !== null);
    const tool: AiChannelToolCall = {
      type: "tool",
      id: publicId,
      title,
      kind,
      status,
      locations,
      createdAt: currentTool?.createdAt ?? this.#timestamp(),
    };
    const entries = [...state.entries];
    if (entryIndex < 0) entries.push(tool);
    else entries[entryIndex] = tool;
    this.#replaceState({ entries: this.#boundEntries(entries) });
  }

  #replacePlan(
    entries: ReadonlyArray<{
      readonly content: string;
      readonly priority: AiChannelPlanEntry["priority"] | null;
      readonly status: AiChannelPlanEntry["status"];
    }>,
  ): void {
    const plan = entries
      .slice(0, MAX_PLAN_ENTRIES)
      .map((entry): AiChannelPlanEntry | null => {
        const content = sanitizeLabel(
          entry.content,
          "",
          this.#preference.workspacePath,
          1_000,
          this.#acceptedSessionId === null ? [] : [this.#acceptedSessionId],
        );
        return content === ""
          ? null
          : { content, priority: entry.priority ?? "medium", status: entry.status };
      })
      .filter((entry): entry is AiChannelPlanEntry => entry !== null);
    this.#replaceState({ plan });
  }

  #handlePermissionRequest(
    hostToken: HostToken,
    request: AiAgentHostPermissionRequest,
    signal: AbortSignal,
  ): Promise<AiAgentHostPermissionOutcome> {
    const state = this.#state;
    const activePrompt = this.#activePrompt;
    if (
      !this.#isCurrentHostToken(hostToken) ||
      state === null ||
      state.status !== "running" ||
      activePrompt === null ||
      activePrompt.generation !== state.generation ||
      request.conversationId !== activePrompt.conversationId ||
      signal.aborted ||
      !isAgentIdentifier(request.tool.id)
    ) {
      return Promise.resolve({ outcome: "cancelled" });
    }

    this.#settlePermission({ outcome: "cancelled" }, true);
    this.#applyToolUpdate(request.tool, false);
    const toolId = this.#toolIds.get(request.tool.id);
    if (toolId === undefined || request.options.length === 0 || request.options.length > 8) {
      return Promise.resolve({ outcome: "cancelled" });
    }

    const optionIds = new Map<string, string>();
    const options: AiChannelPermissionOption[] = [];
    const rawOptionIds = new Set<string>();
    for (const option of request.options) {
      if (!isAgentIdentifier(option.id) || rawOptionIds.has(option.id)) {
        return Promise.resolve({ outcome: "cancelled" });
      }
      rawOptionIds.add(option.id);
      const publicOptionId = this.#createIdentifier("permission-option");
      optionIds.set(publicOptionId, option.id);
      options.push({
        id: publicOptionId,
        name: sanitizeLabel(option.name, "Permission option", this.#preference.workspacePath, 200, [
          activePrompt.conversationId,
        ]),
        kind: option.kind,
      });
    }

    const currentTool = this.#requireState().entries.find(
      (entry): entry is AiChannelToolCall => entry.type === "tool" && entry.id === toolId,
    );
    const permissionRequest: AiChannelPermissionRequest = {
      id: this.#createIdentifier("permission"),
      toolCallId: toolId,
      title: currentTool?.title ?? `${this.#hostDisplayName} tool`,
      kind: currentTool?.kind ?? "other",
      options,
    };

    return new Promise((resolve) => {
      const onAbort = (): void => {
        if (this.#pendingPermission?.requestId === permissionRequest.id) {
          this.#settlePermission({ outcome: "cancelled" }, true);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pendingPermission = {
        generation: state.generation,
        requestId: permissionRequest.id,
        optionIds,
        resolve,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      };
      this.#replaceState({ permissionRequest });
    });
  }

  #handleHostExit(hostToken: HostToken, event: AiAgentHostExit): void {
    if (!this.#isCurrentHostToken(hostToken)) return;
    this.#settlePermission({ outcome: "cancelled" }, false);
    this.#activePrompt = null;
    this.#acceptedSessionId = null;
    this.#host = null;
    this.#hostToken = null;
    const state = this.#state;
    if (state === null || this.#disposed) return;
    this.#replaceState({
      generation: this.#nextGeneration(),
      status: event.reason === "launch-failed" ? "unavailable" : "error",
      permissionRequest: null,
      error:
        event.reason === "launch-failed"
          ? `${this.#hostDisplayName} could not start on this device. Check the installation, then retry.`
          : `${this.#hostDisplayName} disconnected from this AI Channel.`,
    });
  }

  async #finishPrompt(
    activePrompt: ActivePrompt,
    succeeded: boolean,
    error?: unknown,
  ): Promise<void> {
    if (
      this.#activePrompt !== activePrompt ||
      !this.#isCurrentHostToken(activePrompt.hostToken) ||
      this.#requireState().generation !== activePrompt.generation
    ) {
      return;
    }
    this.#activePrompt = null;
    this.#settlePermission({ outcome: "cancelled" }, false);
    if (succeeded) {
      this.#replaceState({ status: "ready", permissionRequest: null, error: null });
      return;
    }
    await this.#failCurrentHost(
      activePrompt.hostToken,
      this.#hostFailureMessage(
        error,
        `${this.#hostDisplayName} stopped before completing the prompt.`,
      ),
    );
  }

  #hostFailureMessage(error: unknown, fallback: string): string {
    if (!(error instanceof AiAgentHostError)) return fallback;
    switch (error.code) {
      case "not-installed":
        return `Install ${this.#hostDisplayName} and make sure ${this.#hostExecutableName} is available on PATH, then retry.`;
      case "not-authenticated":
        return `Sign in to ${this.#hostDisplayName}, then retry.`;
      case "unsupported-version":
        return `Update ${this.#hostDisplayName} to a supported version, then retry.`;
      case "startup-failed":
        return `${this.#hostDisplayName} could not start on this device. Check the installation, then retry.`;
      case "protocol-failed":
        return `${this.#hostDisplayName} could not establish a compatible connection. Update it, then retry.`;
      case "conversation-not-found":
      case "conversation-failed":
      case "turn-failed":
        return fallback;
    }
  }

  async #failCurrentHost(
    hostToken: HostToken,
    message: string,
    existingLifecycleOperation?: number,
  ): Promise<void> {
    const lifecycleOperation = existingLifecycleOperation ?? this.#beginLifecycleOperation();
    if (
      !this.#isCurrentLifecycleOperation(lifecycleOperation) ||
      !this.#isCurrentHostToken(hostToken)
    ) {
      return;
    }
    const host = this.#host;
    this.#settlePermission({ outcome: "cancelled" }, false);
    this.#activePrompt = null;
    this.#acceptedSessionId = null;
    this.#host = null;
    this.#hostToken = null;
    if (host !== null) {
      const retirement = this.#trackHostRetirement(this.#disposeHostBestEffort(host));
      await retirement;
    }
    if (this.#state !== null && this.#isCurrentLifecycleOperation(lifecycleOperation)) {
      this.#replaceState({
        generation: this.#nextGeneration(),
        status: "error",
        permissionRequest: null,
        error: message,
      });
    }
  }

  #settlePermission(outcome: AiAgentHostPermissionOutcome, publish: boolean): void {
    const pending = this.#pendingPermission;
    if (pending === null) return;
    this.#pendingPermission = null;
    pending.removeAbortListener();
    pending.resolve(outcome);
    if (
      publish &&
      this.#state !== null &&
      !this.#disposed &&
      this.#state.permissionRequest !== null
    ) {
      this.#replaceState({ permissionRequest: null });
    }
  }

  async #retireHost(): Promise<void> {
    let existingRetirement = this.#hostRetirement;
    while (existingRetirement !== null) {
      await existingRetirement;
      existingRetirement = this.#hostRetirement;
    }
    const host = this.#host;
    const sessionId = this.#acceptedSessionId;
    const activePrompt = this.#activePrompt;
    this.#hostToken = null;
    this.#host = null;
    this.#acceptedSessionId = null;
    this.#activePrompt = null;
    this.#settlePermission({ outcome: "cancelled" }, false);
    if (host === null) return;
    const retirement = this.#trackHostRetirement(
      this.#retireDetachedHost(host, sessionId, activePrompt),
    );
    await retirement;
  }

  async #retireDetachedHost(
    host: AiAgentHost,
    sessionId: string | null,
    activePrompt: ActivePrompt | null,
  ): Promise<void> {
    if (activePrompt !== null) {
      try {
        await host.cancel(activePrompt.conversationId);
      } catch {
        // Cancellation is best effort during teardown; disposal is the hard lifecycle fence.
      }
    }
    if (sessionId !== null) {
      try {
        await host.close(sessionId);
      } catch {
        // The utility process is disposed below even if the agent cannot close the session.
      }
    }
    await this.#disposeHostBestEffort(host);
  }

  #trackHostRetirement(retirement: Promise<void>): Promise<void> {
    this.#hostRetirement = retirement;
    void retirement.then(() => {
      if (this.#hostRetirement === retirement) this.#hostRetirement = null;
    });
    return retirement;
  }

  async #disposeHostBestEffort(host: AiAgentHost): Promise<void> {
    try {
      await host.dispose();
    } catch {
      // A failed transport cannot be trusted with further work, but exposes no diagnostics.
    }
  }

  #sanitizeLocation(locationPath: string, line: number | null | undefined): string | null {
    const workspacePath = this.#preference.workspacePath;
    if (workspacePath === null || locationPath.includes("\0") || locationPath === "") return null;
    let displayPath: string;
    if (path.isAbsolute(locationPath)) {
      const relative = path.relative(workspacePath, locationPath);
      displayPath =
        relative === ""
          ? "."
          : relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
            ? `Outside workspace/${path.basename(locationPath)}`
            : relative;
    } else {
      const normalized = path.normalize(locationPath);
      displayPath =
        normalized === ".." || normalized.startsWith(`..${path.sep}`)
          ? `Outside workspace/${path.basename(normalized)}`
          : normalized;
    }
    displayPath = sanitizeLabel(
      displayPath,
      "file",
      null,
      4_080,
      this.#acceptedSessionId === null ? [] : [this.#acceptedSessionId],
    );
    if (line !== null && line !== undefined && Number.isSafeInteger(line) && line > 0) {
      displayPath = truncateUtf8(`${displayPath}:${String(line)}`, 4_096);
    }
    return displayPath;
  }

  #boundEntries(entries: readonly AiChannelEntry[]): AiChannelEntry[] {
    const bounded = entries.slice(-MAX_ENTRIES);
    while (
      bounded.length > 0 &&
      Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_ENTRY_BYTES
    ) {
      bounded.shift();
    }
    this.#pruneTrackedIdentifiers(bounded);
    return bounded;
  }

  #pruneTrackedIdentifiers(entries: readonly AiChannelEntry[]): void {
    const retainedEntryIds = new Set(entries.map((entry) => entry.id));
    for (const [rawId, publicId] of this.#messageIds) {
      if (!retainedEntryIds.has(publicId)) {
        this.#messageIds.delete(rawId);
        this.#messageBodies.delete(rawId);
      }
    }
    for (const [rawId, publicId] of this.#toolIds) {
      if (!retainedEntryIds.has(publicId)) this.#toolIds.delete(rawId);
    }
  }

  #clearConversation(): void {
    this.#messageIds.clear();
    this.#messageBodies.clear();
    this.#toolIds.clear();
  }

  #createIdentifier(prefix: string): string {
    const identifier = `${prefix}-${String(this.#nextIdentifier)}`;
    this.#nextIdentifier += 1;
    return identifier;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #nextGeneration(): number {
    const current = this.#requireState().generation;
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error("AI Channel generation limit reached");
    }
    return current + 1;
  }

  #beginLifecycleOperation(): number {
    if (this.#lifecycleOperation >= Number.MAX_SAFE_INTEGER) {
      throw new Error("AI Channel lifecycle operation limit reached");
    }
    this.#lifecycleOperation += 1;
    return this.#lifecycleOperation;
  }

  #isCurrentLifecycleOperation(operation: number): boolean {
    return !this.#disposed && this.#lifecycleOperation === operation;
  }

  #isCurrentHostToken(hostToken: HostToken): boolean {
    return !this.#disposed && this.#hostToken === hostToken;
  }

  #replaceState(patch: Partial<AiChannelState>): AiChannelState {
    const current = this.#requireState();
    const next = aiChannelStateSchema.parse({ ...current, ...patch });
    this.#state = next;
    for (const listener of this.#listeners) {
      try {
        listener(next);
      } catch (error) {
        try {
          this.#reportListenerError(error);
        } catch {
          // Listener reporting cannot prevent other renderer subscribers from receiving state.
        }
      }
    }
    return next;
  }

  #assertGeneration(generation: number): void {
    this.#assertReady();
    if (generation !== this.#requireState().generation) {
      throw new Error("AI Channel request is stale");
    }
  }

  #assertReady(): void {
    if (this.#disposed) throw new Error("AiChannelController has been disposed");
    if (this.#state === null) {
      throw new Error("AiChannelController must be initialized before use");
    }
  }

  #requireState(): AiChannelState {
    this.#assertReady();
    return this.#state as AiChannelState;
  }
}
