import type {
  AiChannelEntry,
  AiChannelPermissionOption,
  AiChannelPlanEntry,
  AiChannelState,
  AiChannelStatus,
  AiChannelToolCall,
  AiChannelToolKind,
} from "@hype-comms/contracts";
import {
  useCallback,
  useEffect,
  memo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  type UIEvent,
} from "react";

import type { AiChannelTransport } from "../../shared/desktop-api";
import { MarkdownBody } from "./message-body";

const PROMPT_MAX_LENGTH = 64_000;
const MIN_COMPOSER_HEIGHT = 48;
const MAX_COMPOSER_HEIGHT = 180;
const STREAM_BOTTOM_THRESHOLD = 48;

type PendingAction =
  "refresh" | "choose-workspace" | "start" | "new-session" | "send" | "cancel" | "permission";

const statusLabels: Readonly<Record<AiChannelStatus, string>> = {
  "not-configured": "Setup needed",
  configured: "Ready to start",
  unavailable: "Unavailable",
  starting: "Starting",
  ready: "Ready",
  running: "Working",
  error: "Needs attention",
};

const toolKindLabels: Readonly<Record<AiChannelToolKind, string>> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Mode",
  other: "Tool",
};

const toolStatusLabels: Readonly<Record<AiChannelToolCall["status"], string>> = {
  pending: "Queued",
  in_progress: "In progress",
  completed: "Done",
  failed: "Failed",
};

function formatActionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function isStreamNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= STREAM_BOTTOM_THRESHOLD;
}

function SparkleMark() {
  return (
    <span className="ai-channel-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M12 2.7c.6 4.8 2.5 6.8 7.3 7.3-4.8.6-6.8 2.5-7.3 7.3-.6-4.8-2.5-6.8-7.3-7.3 4.8-.5 6.7-2.5 7.3-7.3Z" />
        <path d="M19 16.2c.2 2 1.1 2.8 3 3-1.9.2-2.8 1-3 3-.2-2-1.1-2.8-3-3 1.9-.2 2.8-1 3-3Z" />
      </svg>
    </span>
  );
}

function WorkspaceGlyph() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M2.5 5.7h5l1.4 1.6h8.6v7.5a1.7 1.7 0 0 1-1.7 1.7H4.2a1.7 1.7 0 0 1-1.7-1.7V5.7Z" />
      <path d="M2.5 7.3V5.2c0-.9.7-1.7 1.7-1.7h3l1.5 1.7h7.1c.9 0 1.7.7 1.7 1.7v.4" />
    </svg>
  );
}

function ToolGlyph({ kind }: { readonly kind: AiChannelToolKind }) {
  return (
    <span className={`ai-channel-tool-glyph kind-${kind}`} aria-hidden="true">
      {kind === "execute" ? ">_" : toolKindLabels[kind].slice(0, 1)}
    </span>
  );
}

type AiMessageEntry = Extract<AiChannelEntry, { type: "message" }>;

const MessageEntry = memo(function MessageEntry({ entry }: { readonly entry: AiMessageEntry }) {
  if (entry.role === "thought") {
    return (
      <li className="ai-channel-thought-entry">
        <details>
          <summary>
            <span className="ai-channel-thinking-dot" aria-hidden="true" />
            Claude’s notes
          </summary>
          <div>{entry.body}</div>
        </details>
      </li>
    );
  }

  const author = entry.role === "user" ? "You" : "Claude";
  return (
    <li className={`ai-channel-message-entry role-${entry.role}`}>
      <article aria-label={`Message from ${author}`}>
        <header>
          {entry.role === "assistant" ? <SparkleMark /> : null}
          <strong>{author}</strong>
          <time dateTime={entry.createdAt}>{formatMessageTime(entry.createdAt)}</time>
        </header>
        <MarkdownBody body={entry.body} className="ai-channel-message-body" />
      </article>
    </li>
  );
}, areMessageEntriesEqual);

function areMessageEntriesEqual(
  previous: Readonly<{ entry: AiMessageEntry }>,
  next: Readonly<{ entry: AiMessageEntry }>,
): boolean {
  return (
    previous.entry.id === next.entry.id &&
    previous.entry.role === next.entry.role &&
    previous.entry.body === next.entry.body &&
    previous.entry.createdAt === next.entry.createdAt
  );
}

function ToolEntry({ entry }: { readonly entry: AiChannelToolCall }) {
  const location = entry.locations[0];
  return (
    <li className={`ai-channel-tool-entry status-${entry.status}`}>
      <ToolGlyph kind={entry.kind} />
      <div>
        <span className="sr-only">{toolKindLabels[entry.kind]} tool: </span>
        <strong>{entry.title}</strong>
        {location === undefined ? null : (
          <span className="ai-channel-tool-location" title={entry.locations.join("\n")}>
            {location}
            {entry.locations.length > 1 ? ` +${String(entry.locations.length - 1)}` : ""}
          </span>
        )}
      </div>
      <span className="ai-channel-tool-status">{toolStatusLabels[entry.status]}</span>
    </li>
  );
}

function Plan({ entries }: { readonly entries: readonly AiChannelPlanEntry[] }) {
  if (entries.length === 0) return null;
  const completed = entries.filter((entry) => entry.status === "completed").length;
  return (
    <details className="ai-channel-plan" open>
      <summary>
        <span>Plan</span>
        <small>
          {completed} of {entries.length}
        </small>
      </summary>
      <ol>
        {entries.map((entry, index) => (
          <li key={`${entry.content}-${String(index)}`} className={`status-${entry.status}`}>
            <span className="ai-channel-plan-marker" aria-hidden="true" />
            <span>{entry.content}</span>
            <small>{entry.status === "in_progress" ? "Now" : entry.priority}</small>
          </li>
        ))}
      </ol>
    </details>
  );
}

function PermissionOptionButton({
  option,
  disabled,
  firstOptionRef,
  onSelect,
}: {
  readonly option: AiChannelPermissionOption;
  readonly disabled: boolean;
  readonly firstOptionRef?: Ref<HTMLButtonElement>;
  readonly onSelect: (optionId: string) => void;
}) {
  const rejecting = option.kind === "reject_once" || option.kind === "reject_always";
  return (
    <button
      ref={firstOptionRef}
      className={rejecting ? "ai-channel-permission-reject" : "ai-channel-permission-allow"}
      type="button"
      disabled={disabled}
      onClick={() => onSelect(option.id)}
    >
      {option.name}
    </button>
  );
}

function LoadingState({ error, onRetry }: { readonly error: string | null; onRetry: () => void }) {
  if (error !== null) {
    return (
      <div className="ai-channel-centered-state" role="alert">
        <div className="ai-channel-hero-mark error" aria-hidden="true">
          !
        </div>
        <h3>AI Channel didn’t load</h3>
        <p>{error}</p>
        <button className="ai-channel-primary-button" type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="ai-channel-centered-state" role="status">
      <div className="ai-channel-loader" aria-hidden="true" />
      <h3>Opening AI Channel</h3>
      <p>Loading your local Claude workspace…</p>
    </div>
  );
}

export function AiChannel({
  transport,
  active = true,
}: {
  readonly transport: AiChannelTransport;
  readonly active?: boolean;
}) {
  const [state, setState] = useState<AiChannelState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [draft, setDraft] = useState("");
  const pushRevision = useRef(0);
  const lifecycle = useRef(0);
  const actionInFlight = useRef(false);
  const activeRef = useRef(active);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const stream = useRef<HTMLDivElement>(null);
  const streamEnd = useRef<HTMLDivElement>(null);
  const stickToStreamEnd = useRef(true);
  const firstPermissionOption = useRef<HTMLButtonElement>(null);
  const startActionButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const focusAfterWorkspaceChoice = useRef(false);
  const focusAfterStart = useRef(false);
  const previousPermissionId = useRef<string | null>(null);
  const restorePermissionFocus = useRef(false);

  activeRef.current = active;

  const applyState = useCallback((next: AiChannelState): void => {
    setState((current) =>
      current === null || next.generation >= current.generation ? next : current,
    );
    setLoadError(null);
  }, []);

  useEffect(() => {
    const lifecycleId = lifecycle.current + 1;
    lifecycle.current = lifecycleId;
    pushRevision.current = 0;
    setState(null);
    setLoadError(null);
    setActionError(null);
    setPendingAction(null);
    actionInFlight.current = false;

    const unsubscribe = transport.onAiChannelStateChanged((next) => {
      if (lifecycle.current !== lifecycleId) return;
      pushRevision.current += 1;
      applyState(next);
    });
    const revision = pushRevision.current;
    void transport
      .getAiChannelState()
      .then((next) => {
        if (lifecycle.current === lifecycleId && pushRevision.current === revision) {
          applyState(next);
        }
      })
      .catch((error: unknown) => {
        if (lifecycle.current === lifecycleId) {
          setLoadError(formatActionError(error, "Couldn’t load the local AI Channel."));
        }
      });

    return () => {
      if (lifecycle.current === lifecycleId) lifecycle.current += 1;
      unsubscribe();
    };
  }, [applyState, transport]);

  useEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = "auto";
    const height = Math.min(
      Math.max(element.scrollHeight, MIN_COMPOSER_HEIGHT),
      MAX_COMPOSER_HEIGHT,
    );
    element.style.height = `${String(height)}px`;
    element.style.overflowY = element.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    if (active && stickToStreamEnd.current) {
      streamEnd.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [active, state?.entries, state?.permissionRequest]);

  useEffect(() => {
    const permissionId = state?.permissionRequest?.id ?? null;
    const previousId = previousPermissionId.current;
    previousPermissionId.current = permissionId;

    if (permissionId !== null) {
      restorePermissionFocus.current = false;
      if (active && pendingAction === null) firstPermissionOption.current?.focus();
      return;
    }

    if (previousId !== null) restorePermissionFocus.current = true;
    if (!restorePermissionFocus.current) return;
    if (!active) {
      restorePermissionFocus.current = false;
      return;
    }
    if (pendingAction !== null) return;

    if (state?.status === "starting") return;
    restorePermissionFocus.current = false;
    if (state?.status === "ready") textarea.current?.focus();
    else if (state?.status === "running") cancelButton.current?.focus();
    else startActionButton.current?.focus();
  }, [active, pendingAction, state?.permissionRequest?.id, state?.status]);

  const acceptActionState = useCallback(
    (next: AiChannelState, lifecycleId: number, revision: number): void => {
      if (lifecycle.current === lifecycleId && pushRevision.current === revision) applyState(next);
    },
    [applyState],
  );

  const runStateAction = useCallback(
    async (
      action: PendingAction,
      operation: () => Promise<AiChannelState>,
      fallbackError: string,
    ): Promise<boolean> => {
      if (pendingAction !== null || actionInFlight.current) return false;
      const lifecycleId = lifecycle.current;
      const revision = pushRevision.current;
      actionInFlight.current = true;
      setPendingAction(action);
      setActionError(null);
      try {
        const next = await operation();
        if (lifecycle.current !== lifecycleId) return false;
        acceptActionState(next, lifecycleId, revision);
        return true;
      } catch (error: unknown) {
        if (lifecycle.current === lifecycleId) {
          setActionError(formatActionError(error, fallbackError));
        }
        return false;
      } finally {
        if (lifecycle.current === lifecycleId) {
          actionInFlight.current = false;
          setPendingAction(null);
        }
      }
    },
    [acceptActionState, pendingAction],
  );

  const refresh = useCallback((): void => {
    void runStateAction(
      "refresh",
      () => transport.getAiChannelState(),
      "Couldn’t load the local AI Channel.",
    ).then((succeeded) => {
      if (succeeded) setLoadError(null);
    });
  }, [runStateAction, transport]);

  const chooseWorkspace = useCallback((): void => {
    const baselineGeneration = state?.generation ?? null;
    const baselineStatus = state?.status ?? null;
    const baselineWorkspaceName = state?.workspaceName ?? null;
    let workspaceChanged = false;
    focusAfterWorkspaceChoice.current = true;
    stickToStreamEnd.current = true;
    void runStateAction(
      "choose-workspace",
      async () => {
        const next = await transport.chooseAiChannelWorkspace();
        workspaceChanged =
          next.generation !== baselineGeneration ||
          next.status !== baselineStatus ||
          next.workspaceName !== baselineWorkspaceName;
        return next;
      },
      "Couldn’t open the folder picker.",
    ).then((succeeded) => {
      if (!succeeded || !workspaceChanged) focusAfterWorkspaceChoice.current = false;
    });
  }, [runStateAction, state, transport]);

  const start = useCallback((): void => {
    if (state === null) return;
    focusAfterStart.current = true;
    stickToStreamEnd.current = true;
    void runStateAction(
      "start",
      () => transport.startAiChannel({ generation: state.generation }),
      "Couldn’t start Claude Code.",
    ).then((succeeded) => {
      if (!succeeded) focusAfterStart.current = false;
    });
  }, [runStateAction, state, transport]);

  const newSession = useCallback((): void => {
    if (state === null) return;
    const previousStickToStreamEnd = stickToStreamEnd.current;
    stickToStreamEnd.current = true;
    void runStateAction(
      "new-session",
      () => transport.newAiChannelSession({ generation: state.generation }),
      "Couldn’t start a new chat.",
    ).then((succeeded) => {
      if (!succeeded) {
        stickToStreamEnd.current = previousStickToStreamEnd;
        return;
      }
      setDraft("");
      if (activeRef.current) textarea.current?.focus();
    });
  }, [runStateAction, state, transport]);

  const cancel = useCallback((): void => {
    if (state === null) return;
    void runStateAction(
      "cancel",
      () => transport.cancelAiChannelPrompt({ generation: state.generation }),
      "Couldn’t cancel Claude’s response.",
    );
  }, [runStateAction, state, transport]);

  const answerPermission = useCallback(
    (optionId: string): void => {
      const request = state?.permissionRequest;
      if (state === null || request == null) return;
      void runStateAction(
        "permission",
        () =>
          transport.respondAiChannelPermission({
            generation: state.generation,
            requestId: request.id,
            optionId,
          }),
        "Couldn’t send your permission choice.",
      );
    },
    [runStateAction, state, transport],
  );

  const submitPrompt = useCallback(async (): Promise<void> => {
    if (state === null || state.status !== "ready") return;
    const prompt = draft.trim();
    if (prompt === "") return;
    const previousStickToStreamEnd = stickToStreamEnd.current;
    stickToStreamEnd.current = true;
    const succeeded = await runStateAction(
      "send",
      () => transport.sendAiChannelPrompt({ generation: state.generation, prompt }),
      "Claude didn’t receive that prompt. Your draft is still here.",
    );
    if (succeeded) setDraft("");
    else stickToStreamEnd.current = previousStickToStreamEnd;
  }, [draft, runStateAction, state, transport]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitPrompt();
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey) ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const handleStreamScroll = (event: UIEvent<HTMLDivElement>): void => {
    stickToStreamEnd.current = isStreamNearBottom(event.currentTarget);
  };

  useEffect(() => {
    const status = state?.status;
    if (focusAfterWorkspaceChoice.current && status === "configured") {
      if (!active) focusAfterWorkspaceChoice.current = false;
      else if (pendingAction === null) {
        focusAfterWorkspaceChoice.current = false;
        startActionButton.current?.focus();
      }
    }

    if (
      focusAfterStart.current &&
      status !== undefined &&
      status !== "starting" &&
      status !== "configured"
    ) {
      if (!active) focusAfterStart.current = false;
      else if (pendingAction === null) {
        focusAfterStart.current = false;
        if (status === "ready") textarea.current?.focus();
        else startActionButton.current?.focus();
      }
    }
  }, [active, pendingAction, state?.generation, state?.status]);

  const configured = state?.workspaceName !== null && state?.workspaceName !== undefined;
  const disabledByLifecycle = state?.status === "starting" || state?.status === "running";
  const hasSessionSurface =
    state?.status === "starting" ||
    state?.status === "ready" ||
    state?.status === "running" ||
    state?.status === "error";
  const showConversation =
    state !== null &&
    configured &&
    state.status !== "not-configured" &&
    state.status !== "configured" &&
    state.status !== "unavailable";
  const sendDisabled = state?.status !== "ready" || pendingAction !== null || draft.trim() === "";
  const permissionFocusIndex = Math.max(
    0,
    state?.permissionRequest?.options.findIndex(
      (option) => option.kind === "reject_once" || option.kind === "reject_always",
    ) ?? 0,
  );

  return (
    <section className="ai-channel" aria-labelledby="ai-channel-title" hidden={!active}>
      <header className="ai-channel-header">
        <div className="ai-channel-title-block">
          <SparkleMark />
          <div>
            <h2 id="ai-channel-title">AI Channel</h2>
            <p>
              {configured ? (
                <>
                  <WorkspaceGlyph />
                  <span title={state.workspaceName ?? undefined}>{state.workspaceName}</span>
                </>
              ) : (
                "Claude Code, grounded in a folder you choose"
              )}
            </p>
          </div>
        </div>
        <div className="ai-channel-header-actions">
          {state === null ? null : (
            <span
              className={`ai-channel-status status-${state.status}`}
              role="status"
              aria-live="polite"
            >
              <span aria-hidden="true" />
              {state.status === "running" && state.permissionRequest !== null
                ? "Waiting for you"
                : statusLabels[state.status]}
            </span>
          )}
          {configured && hasSessionSurface ? (
            <button
              className="ai-channel-secondary-button"
              type="button"
              disabled={disabledByLifecycle || pendingAction !== null}
              onClick={chooseWorkspace}
            >
              Change folder
            </button>
          ) : null}
          {state !== null && configured && hasSessionSurface ? (
            <button
              className="ai-channel-secondary-button"
              type="button"
              disabled={state.status !== "ready" || pendingAction !== null}
              onClick={newSession}
            >
              New chat
            </button>
          ) : null}
        </div>
      </header>

      <div className="ai-channel-content">
        {state === null ? (
          <LoadingState error={loadError ?? actionError} onRetry={refresh} />
        ) : state.status === "unavailable" || (state.status === "error" && !configured) ? (
          <div className="ai-channel-centered-state" role="alert">
            <div className="ai-channel-hero-mark error" aria-hidden="true">
              !
            </div>
            <p className="eyebrow">Claude Code unavailable</p>
            <h3>AI Channel can’t connect yet</h3>
            <p>{state.error ?? "Claude Code isn’t available on this device."}</p>
            <div className="ai-channel-centered-actions">
              <button
                ref={startActionButton}
                className="ai-channel-primary-button"
                type="button"
                disabled={pendingAction !== null}
                onClick={start}
              >
                {pendingAction === "start" ? "Retrying…" : "Retry"}
              </button>
              <button
                className="ai-channel-secondary-button"
                type="button"
                disabled={pendingAction !== null}
                onClick={chooseWorkspace}
              >
                {configured ? "Change folder" : "Choose folder"}
              </button>
            </div>
            {actionError !== null ? (
              <p className="ai-channel-inline-error" role="alert">
                {actionError}
              </p>
            ) : null}
          </div>
        ) : !configured || state.status === "not-configured" || state.status === "configured" ? (
          <div className="ai-channel-centered-state ai-channel-setup">
            <div className="ai-channel-hero-mark" aria-hidden="true">
              <WorkspaceGlyph />
            </div>
            <p className="eyebrow">Local workspace</p>
            <h3>
              {configured
                ? `${state.workspaceName} is ready to connect`
                : "Choose where Claude works"}
            </h3>
            <p>
              The chosen folder is Claude’s working directory, not an OS sandbox. Claude can read or
              change files and run commands there; approved tools and your Claude settings may also
              access files outside it.
            </p>
            <div className="ai-channel-centered-actions">
              {configured ? (
                <button
                  ref={startActionButton}
                  className="ai-channel-primary-button"
                  type="button"
                  disabled={pendingAction !== null}
                  onClick={start}
                >
                  {pendingAction === "start" ? "Starting…" : "Start Claude"}
                </button>
              ) : (
                <button
                  ref={startActionButton}
                  className="ai-channel-primary-button"
                  type="button"
                  disabled={pendingAction !== null}
                  onClick={chooseWorkspace}
                >
                  {pendingAction === "choose-workspace" ? "Choosing…" : "Choose folder"}
                </button>
              )}
              {configured ? (
                <button
                  className="ai-channel-secondary-button"
                  type="button"
                  disabled={pendingAction !== null}
                  onClick={chooseWorkspace}
                >
                  Choose another folder
                </button>
              ) : null}
            </div>
            {actionError !== null ? (
              <p className="ai-channel-inline-error" role="alert">
                {actionError}
              </p>
            ) : null}
          </div>
        ) : showConversation ? (
          <>
            <div
              ref={stream}
              className="ai-channel-stream"
              aria-live="polite"
              aria-busy={state.status === "running"}
              onScroll={handleStreamScroll}
            >
              {state.status === "error" ? (
                <div className="ai-channel-error-banner" role="alert">
                  <div>
                    <strong>Claude Code disconnected</strong>
                    <span>{state.error ?? "The local session stopped unexpectedly."}</span>
                  </div>
                  <button
                    ref={startActionButton}
                    className="ai-channel-secondary-button"
                    type="button"
                    disabled={pendingAction !== null}
                    onClick={start}
                  >
                    {pendingAction === "start" ? "Retrying…" : "Retry"}
                  </button>
                </div>
              ) : null}

              <Plan entries={state.plan} />

              {state.entries.length === 0 ? (
                <div className="ai-channel-empty-state">
                  {state.status === "starting" ? (
                    <>
                      <div className="ai-channel-loader" aria-hidden="true" />
                      <h3>Starting Claude Code</h3>
                      <p>Preparing a Claude Code session for {state.workspaceName}…</p>
                    </>
                  ) : (
                    <>
                      <SparkleMark />
                      <h3>What should we work on?</h3>
                      <p>
                        Ask Claude to explore the code, explain a behavior, or help shape a change
                        in {state.workspaceName}.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <ol className="ai-channel-entry-list">
                  {state.entries.map((entry) =>
                    entry.type === "message" ? (
                      <MessageEntry key={entry.id} entry={entry} />
                    ) : (
                      <ToolEntry key={entry.id} entry={entry} />
                    ),
                  )}
                </ol>
              )}

              {state.status === "running" ? (
                <div className="ai-channel-working" role="status">
                  <span aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  {state.permissionRequest === null
                    ? "Claude is working…"
                    : "Claude is waiting for your permission."}
                </div>
              ) : null}
              <div ref={streamEnd} />
            </div>

            <div className="ai-channel-input-region">
              {state.permissionRequest === null ? null : (
                <section
                  className="ai-channel-permission"
                  role="alertdialog"
                  aria-labelledby="ai-channel-permission-title"
                  aria-describedby="ai-channel-permission-description"
                >
                  <div className="ai-channel-permission-icon" aria-hidden="true">
                    !
                  </div>
                  <div className="ai-channel-permission-copy">
                    <p className="eyebrow">Permission requested</p>
                    <h3 id="ai-channel-permission-title">{state.permissionRequest.title}</h3>
                    <p id="ai-channel-permission-description">
                      Review this {toolKindLabels[state.permissionRequest.kind].toLowerCase()}{" "}
                      request carefully. The chosen folder is only Claude’s working directory, not a
                      sandbox; approved tools and settings may access files outside it.
                    </p>
                  </div>
                  <div className="ai-channel-permission-actions">
                    {state.permissionRequest.options.map((option, index) => (
                      <PermissionOptionButton
                        key={option.id}
                        option={option}
                        disabled={pendingAction !== null}
                        firstOptionRef={
                          index === permissionFocusIndex ? firstPermissionOption : undefined
                        }
                        onSelect={answerPermission}
                      />
                    ))}
                  </div>
                </section>
              )}

              <form
                className="ai-channel-composer"
                onSubmit={submit}
                aria-busy={pendingAction === "send"}
              >
                <label className="sr-only" htmlFor="ai-channel-prompt">
                  Message Claude
                </label>
                <div className="ai-channel-composer-field">
                  <textarea
                    ref={textarea}
                    id="ai-channel-prompt"
                    value={draft}
                    maxLength={PROMPT_MAX_LENGTH}
                    rows={1}
                    disabled={state.status !== "ready" || pendingAction === "send"}
                    placeholder={
                      state.status === "running"
                        ? "Claude is working on your last prompt…"
                        : state.status === "error"
                          ? "Reconnect Claude to continue"
                          : "Ask Claude about this workspace…"
                    }
                    aria-describedby="ai-channel-composer-hint"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                  />
                  <span className="ai-channel-composer-spark" aria-hidden="true">
                    ✦
                  </span>
                </div>
                {state.status === "running" ? (
                  <button
                    ref={cancelButton}
                    className="ai-channel-cancel-button"
                    type="button"
                    disabled={pendingAction !== null}
                    onClick={cancel}
                  >
                    <span aria-hidden="true" />
                    {pendingAction === "cancel" ? "Cancelling…" : "Cancel"}
                  </button>
                ) : (
                  <button className="ai-channel-send-button" type="submit" disabled={sendDisabled}>
                    {pendingAction === "send" ? "Sending…" : "Send"}
                    <span aria-hidden="true">↑</span>
                  </button>
                )}
                <p className="ai-channel-composer-hint" id="ai-channel-composer-hint">
                  <kbd>Ctrl</kbd> or <kbd>⌘</kbd> + <kbd>Enter</kbd> to send
                </p>
                {actionError !== null ? (
                  <p className="ai-channel-inline-error" role="alert">
                    {actionError}
                  </p>
                ) : null}
              </form>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
