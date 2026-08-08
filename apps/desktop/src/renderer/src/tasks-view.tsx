import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";

import type { Task, TaskPriority, TaskStatus, User } from "@hmm-chat/contracts";

type TaskViewMode = "board" | "list";

const COLUMNS: readonly { readonly status: TaskStatus; readonly label: string }[] = [
  { status: "todo", label: "To do" },
  { status: "in_progress", label: "In progress" },
  { status: "done", label: "Done" },
];

const PRIORITIES: readonly { readonly value: TaskPriority; readonly label: string }[] = [
  { value: "none", label: "No priority" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

interface TaskDraft {
  readonly title: string;
  readonly description: string | null;
  readonly priority: TaskPriority;
  readonly assigneeId: string | null;
  readonly dueOn: string | null;
}

interface TasksViewProps {
  readonly conversationId: string;
  readonly personal: boolean;
  readonly archived: boolean;
  readonly currentUserId: string;
  readonly members: readonly User[];
  readonly assignableMembers: (conversationId: string) => readonly User[];
  readonly tasks: readonly Task[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly conversationName: (conversationId: string) => string;
  readonly isConversationArchived: (conversationId: string) => boolean;
  readonly onCreate: (input: TaskDraft) => Promise<Task>;
  readonly onUpdate: (taskId: string, input: TaskDraft) => Promise<Task>;
  readonly onMove: (
    taskId: string,
    status: TaskStatus,
    beforeTaskId: string | null,
  ) => Promise<Task>;
  readonly onOpenSource: (task: Task) => void;
}

function preferenceKey(conversationId: string): string {
  return `hype-comms:tasks-view:${conversationId}`;
}

function initialMode(conversationId: string, personal: boolean): TaskViewMode {
  let saved: string | null = null;
  try {
    saved = window.localStorage?.getItem(preferenceKey(conversationId)) ?? null;
  } catch {
    // The board remains usable when a hardened renderer disables DOM storage.
  }
  return saved === "board" || saved === "list" ? saved : personal ? "list" : "board";
}

function rememberMode(conversationId: string, mode: TaskViewMode): void {
  try {
    window.localStorage?.setItem(preferenceKey(conversationId), mode);
  } catch {
    // View preference persistence is optional; task data never lives here.
  }
}

function memberName(members: readonly User[], userId: string | null): string {
  if (userId === null) return "Unassigned";
  return members.find((member) => member.id === userId)?.displayName ?? "Former member";
}

function priorityLabel(priority: TaskPriority): string {
  return PRIORITIES.find((entry) => entry.value === priority)?.label ?? priority;
}

function statusLabel(status: TaskStatus): string {
  return COLUMNS.find((entry) => entry.status === status)?.label ?? status;
}

function memberInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toLocaleUpperCase() ?? "")
    .join("");
}

function dueLabel(dueOn: string | null): string | null {
  if (dueOn === null) return null;
  const [year, month, day] = dueOn.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return dueOn;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(year, month - 1, day),
  );
}

type DueState = "overdue" | "today" | "upcoming" | "complete";

function localDate(now = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dueState(task: Task): DueState | null {
  if (task.dueOn === null) return null;
  if (task.status === "done") return "complete";
  const today = localDate();
  return task.dueOn < today ? "overdue" : task.dueOn === today ? "today" : "upcoming";
}

function PriorityChip({ priority }: { readonly priority: TaskPriority }) {
  if (priority === "none") return null;
  const label = priorityLabel(priority);
  return (
    <span className={`task-priority-chip priority-${priority}`} aria-label={`Priority: ${label}`}>
      {label}
    </span>
  );
}

function DueBadge({ task }: { readonly task: Task }) {
  const label = dueLabel(task.dueOn);
  const state = dueState(task);
  if (label === null || state === null) return null;
  const stateLabel = state === "complete" ? "completed" : state;
  return (
    <span className={`task-due-badge due-${state}`} aria-label={`Due ${label}, ${stateLabel}`}>
      {state === "overdue" ? "Overdue · " : state === "today" ? "Today · " : ""}
      {label}
    </span>
  );
}

function AssigneeBadge({
  members,
  userId,
}: {
  readonly members: readonly User[];
  userId: string | null;
}) {
  const name = memberName(members, userId);
  return (
    <span className="task-assignee-badge" aria-label={`Assignee: ${name}`}>
      <span className="task-assignee-initials" aria-hidden="true">
        {memberInitials(name)}
      </span>
      <span>{name}</span>
    </span>
  );
}

function TaskCard({
  task,
  members,
  sourceName,
  disabled,
  moving,
  canMoveEarlier,
  canMoveLater,
  canMoveLeft,
  canMoveRight,
  onSelect,
  onDragStart,
  onDropBefore,
  onMoveEarlier,
  onMoveLater,
  onMoveLeft,
  onMoveRight,
}: {
  readonly task: Task;
  readonly members: readonly User[];
  readonly sourceName: string;
  readonly disabled: boolean;
  readonly moving: boolean;
  readonly canMoveEarlier: boolean;
  readonly canMoveLater: boolean;
  readonly canMoveLeft: boolean;
  readonly canMoveRight: boolean;
  readonly onSelect: () => void;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onDropBefore: (event: DragEvent<HTMLElement>) => void;
  readonly onMoveEarlier: () => void;
  readonly onMoveLater: () => void;
  readonly onMoveLeft: () => void;
  readonly onMoveRight: () => void;
}) {
  const status = statusLabel(task.status);
  return (
    <article
      className={`task-card priority-${task.priority}`}
      draggable={!disabled}
      aria-busy={moving}
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDropBefore}
    >
      <button className="task-card-main" type="button" onClick={onSelect}>
        <span className="task-key">
          {sourceName} · {task.number}
        </span>
        <strong>{task.title}</strong>
        <span className="sr-only">Status: {status}</span>
        <span className="task-card-meta">
          <AssigneeBadge members={members} userId={task.assigneeId} />
          <PriorityChip priority={task.priority} />
          <DueBadge task={task} />
        </span>
        {moving && (
          <span className="task-card-pending" role="status">
            Moving task…
          </span>
        )}
      </button>
      <div className="task-card-moves" role="group" aria-label={`Move ${task.title}`}>
        <button
          type="button"
          title="Move left"
          aria-label={`Move ${task.title} to ${statusLabel(adjacentStatus(task.status, -1))}`}
          disabled={disabled || !canMoveLeft}
          onClick={onMoveLeft}
        >
          ←
        </button>
        <button
          type="button"
          title="Move up"
          aria-label={`Move ${task.title} earlier in ${status}`}
          disabled={disabled || !canMoveEarlier}
          onClick={onMoveEarlier}
        >
          ↑
        </button>
        <button
          type="button"
          title="Move down"
          aria-label={`Move ${task.title} later in ${status}`}
          disabled={disabled || !canMoveLater}
          onClick={onMoveLater}
        >
          ↓
        </button>
        <button
          type="button"
          title="Move right"
          aria-label={`Move ${task.title} to ${statusLabel(adjacentStatus(task.status, 1))}`}
          disabled={disabled || !canMoveRight}
          onClick={onMoveRight}
        >
          →
        </button>
      </div>
    </article>
  );
}

function adjacentStatus(status: TaskStatus, offset: -1 | 1): TaskStatus {
  const index = COLUMNS.findIndex((column) => column.status === status);
  return COLUMNS[Math.max(0, Math.min(COLUMNS.length - 1, index + offset))]?.status ?? status;
}

export function TasksView({
  conversationId,
  personal,
  archived,
  currentUserId,
  members,
  assignableMembers,
  tasks,
  busy,
  error,
  conversationName,
  isConversationArchived,
  onCreate,
  onUpdate,
  onMove,
  onOpenSource,
}: TasksViewProps) {
  const [mode, setMode] = useState<TaskViewMode>(() => initialMode(conversationId, personal));
  const [includeAssigned, setIncludeAssigned] = useState(true);
  const [title, setTitle] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [assigneeId, setAssigneeId] = useState(personal ? currentUserId : "");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const movingTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    rememberMode(conversationId, mode);
  }, [conversationId, mode]);

  useEffect(() => {
    setMode(initialMode(conversationId, personal));
    setSelectedTaskId(null);
    setAssigneeId(personal ? currentUserId : "");
  }, [conversationId, currentUserId, personal]);

  const visibleTasks = useMemo(
    () =>
      tasks.filter((task) => {
        if (task.conversationId === conversationId) return true;
        return (
          personal &&
          includeAssigned &&
          task.assigneeId === currentUserId &&
          !isConversationArchived(task.conversationId)
        );
      }),
    [conversationId, currentUserId, includeAssigned, isConversationArchived, personal, tasks],
  );

  const byStatus = useMemo(() => {
    const grouped = new Map<TaskStatus, Task[]>(COLUMNS.map((column) => [column.status, []]));
    for (const task of visibleTasks) grouped.get(task.status)?.push(task);
    for (const columnTasks of grouped.values()) {
      columnTasks.sort((left, right) => {
        const leftRank = BigInt(left.rank);
        const rightRank = BigInt(right.rank);
        return leftRank < rightRank
          ? -1
          : leftRank > rightRank
            ? 1
            : left.id.localeCompare(right.id);
      });
    }
    return grouped;
  }, [visibleTasks]);

  const selectedTask = visibleTasks.find((task) => task.id === selectedTaskId) ?? null;

  const submitTask = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "" || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      await onCreate({
        title: trimmed,
        description: null,
        priority,
        assigneeId: assigneeId === "" ? null : assigneeId,
        dueOn: dueOn === "" ? null : dueOn,
      });
      setTitle("");
      setDueOn("");
      setPriority("none");
      setFormError("");
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Could not create the task");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const move = async (
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null,
  ): Promise<void> => {
    if (
      archived ||
      isConversationArchived(task.conversationId) ||
      movingTaskIdRef.current !== null
    ) {
      return;
    }
    movingTaskIdRef.current = task.id;
    setMovingTaskId(task.id);
    try {
      await onMove(task.id, status, beforeTaskId);
      setFormError("");
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Could not move the task");
    } finally {
      movingTaskIdRef.current = null;
      setMovingTaskId(null);
    }
  };

  const collectionBusy = busy || creating || movingTaskId !== null;
  const emptyState =
    visibleTasks.length === 0
      ? busy
        ? {
            title: "Loading tasks…",
            detail: "Fetching the latest work for this conversation.",
          }
        : error !== null
          ? {
              title: "Tasks could not be loaded",
              detail: "Return to Chat and open Tasks again to retry.",
            }
          : archived
            ? {
                title: "No archived tasks",
                detail: "This channel is archived, so its task board is read-only.",
              }
            : personal
              ? {
                  title: includeAssigned ? "You're all caught up" : "Your personal list is empty",
                  detail: includeAssigned
                    ? "Tasks you add here or that others assign to you will appear here."
                    : "Add a personal task whenever something needs your attention.",
                }
              : {
                  title: "No tasks yet",
                  detail: "Add the first task when work emerges from the conversation.",
                }
      : null;

  return (
    <section className="tasks-view" aria-busy={collectionBusy}>
      <header className="tasks-toolbar">
        <div className="tasks-title">
          <h3>{personal ? "My Tasks" : "Channel tasks"}</h3>
          <span>
            {visibleTasks.length} {visibleTasks.length === 1 ? "task" : "tasks"}
          </span>
        </div>
        {personal && (
          <label className="assigned-toggle">
            <input
              type="checkbox"
              checked={includeAssigned}
              onChange={(event) => setIncludeAssigned(event.target.checked)}
            />
            Include assigned work
          </label>
        )}
        <div className="view-toggle" aria-label="Task view">
          <button
            type="button"
            className={mode === "board" ? "active" : ""}
            onClick={() => setMode("board")}
          >
            Board
          </button>
          <button
            type="button"
            className={mode === "list" ? "active" : ""}
            onClick={() => setMode("list")}
          >
            List
          </button>
        </div>
      </header>

      {archived ? (
        <p className="task-readonly-banner" role="note">
          Archived channel · Tasks are read-only.
        </p>
      ) : (
        <form
          className="task-quick-add"
          aria-busy={creating}
          onSubmit={(event) => void submitTask(event)}
        >
          <input
            aria-label="Task title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={personal ? "Add something to your list…" : "Add a task to this channel…"}
            maxLength={240}
          />
          <select
            aria-label="Assignee"
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            <option value="">Unassigned</option>
            {assignableMembers(conversationId).map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
          <select
            aria-label="Priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value as TaskPriority)}
          >
            {PRIORITIES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Due date"
            type="date"
            value={dueOn}
            onChange={(event) => setDueOn(event.target.value)}
          />
          <button type="submit" disabled={busy || creating || title.trim() === ""}>
            {creating ? "Adding task…" : "Add task"}
          </button>
        </form>
      )}

      {busy && visibleTasks.length > 0 && !creating && movingTaskId === null && (
        <p className="task-progress" role="status">
          Refreshing tasks…
        </p>
      )}

      {(error !== null || formError !== "") && (
        <p className="task-error" role="alert">
          {formError || error}
        </p>
      )}

      {emptyState !== null ? (
        <div className="task-empty-state task-collection-state" role={busy ? "status" : undefined}>
          <h4>{emptyState.title}</h4>
          <p>{emptyState.detail}</p>
        </div>
      ) : mode === "board" ? (
        <div className="kanban-board" role="region" aria-label="Kanban board">
          {COLUMNS.map((column) => {
            const columnTasks = byStatus.get(column.status) ?? [];
            return (
              <section
                className="kanban-column"
                key={column.status}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const task = visibleTasks.find((candidate) => candidate.id === draggedTaskId);
                  if (task !== undefined) void move(task, column.status, null);
                  setDraggedTaskId(null);
                }}
              >
                <header>
                  <h4>{column.label}</h4>
                  <span>{columnTasks.length}</span>
                </header>
                <div className="kanban-cards">
                  {columnTasks.map((task) => {
                    const siblings = columnTasks.filter(
                      (candidate) => candidate.conversationId === task.conversationId,
                    );
                    const siblingIndex = siblings.findIndex(
                      (candidate) => candidate.id === task.id,
                    );
                    const taskReadOnly =
                      archived ||
                      isConversationArchived(task.conversationId) ||
                      movingTaskId !== null;
                    return (
                      <TaskCard
                        key={task.id}
                        task={task}
                        members={members}
                        sourceName={conversationName(task.conversationId)}
                        disabled={taskReadOnly}
                        moving={movingTaskId === task.id}
                        canMoveEarlier={siblingIndex > 0}
                        canMoveLater={siblingIndex >= 0 && siblingIndex < siblings.length - 1}
                        canMoveLeft={COLUMNS[0]?.status !== task.status}
                        canMoveRight={COLUMNS.at(-1)?.status !== task.status}
                        onSelect={() => setSelectedTaskId(task.id)}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          setDraggedTaskId(task.id);
                        }}
                        onDropBefore={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const dragged = visibleTasks.find(
                            (candidate) => candidate.id === draggedTaskId,
                          );
                          if (dragged !== undefined && dragged.id !== task.id) {
                            void move(
                              dragged,
                              column.status,
                              dragged.conversationId === task.conversationId ? task.id : null,
                            );
                          }
                          setDraggedTaskId(null);
                        }}
                        onMoveEarlier={() => {
                          const before = siblings[siblingIndex - 1];
                          if (before !== undefined) void move(task, column.status, before.id);
                        }}
                        onMoveLater={() => {
                          const afterNext = siblings[siblingIndex + 2];
                          if (siblingIndex < siblings.length - 1) {
                            void move(task, column.status, afterNext?.id ?? null);
                          }
                        }}
                        onMoveLeft={() => void move(task, adjacentStatus(task.status, -1), null)}
                        onMoveRight={() => void move(task, adjacentStatus(task.status, 1), null)}
                      />
                    );
                  })}
                  {columnTasks.length === 0 && <p className="kanban-empty">Drop a task here</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="task-list-view">
          {visibleTasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={`task-list-row status-${task.status}`}
              onClick={() => setSelectedTaskId(task.id)}
            >
              <span className={`task-check status-${task.status}`} aria-hidden="true">
                {task.status === "done" ? "✓" : ""}
              </span>
              <span className="task-list-copy">
                <strong>{task.title}</strong>
                <span className="sr-only">Status: {statusLabel(task.status)}</span>
                <small>{conversationName(task.conversationId)}</small>
              </span>
              <span className="task-list-detail">
                <AssigneeBadge members={members} userId={task.assigneeId} />
                <PriorityChip priority={task.priority} />
                <DueBadge task={task} />
              </span>
            </button>
          ))}
        </div>
      )}

      {selectedTask !== null && (
        <TaskDetail
          task={selectedTask}
          assignableMembers={assignableMembers(selectedTask.conversationId)}
          disabled={archived || isConversationArchived(selectedTask.conversationId)}
          sourceName={conversationName(selectedTask.conversationId)}
          onClose={() => setSelectedTaskId(null)}
          onSave={onUpdate}
          onMove={onMove}
          onOpenSource={onOpenSource}
        />
      )}
    </section>
  );
}

function TaskDetail({
  task,
  assignableMembers,
  disabled,
  sourceName,
  onClose,
  onSave,
  onMove,
  onOpenSource,
}: {
  readonly task: Task;
  readonly assignableMembers: readonly User[];
  readonly disabled: boolean;
  readonly sourceName: string;
  readonly onClose: () => void;
  readonly onSave: (taskId: string, input: TaskDraft) => Promise<Task>;
  readonly onMove: (
    taskId: string,
    status: TaskStatus,
    beforeTaskId: string | null,
  ) => Promise<Task>;
  readonly onOpenSource: (task: Task) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState(task.priority);
  const [assigneeId, setAssigneeId] = useState(task.assigneeId ?? "");
  const [dueOn, setDueOn] = useState(task.dueOn ?? "");
  const [status, setStatus] = useState(task.status);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const titleId = `task-detail-title-${task.id}`;

  useEffect(() => {
    const focusTarget = disabled ? closeButton.current : titleInput.current;
    focusTarget?.focus();
    const restoreTarget = previouslyFocused.current;
    return () => restoreTarget?.focus();
  }, [disabled]);

  useEffect(() => {
    if (savingRef.current) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
    setPriority(task.priority);
    setAssigneeId(task.assigneeId ?? "");
    setDueOn(task.dueOn ?? "");
    setStatus(task.status);
  }, [task]);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (disabled || title.trim() === "" || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      let current = task;
      if (status !== task.status) current = await onMove(task.id, status, null);
      await onSave(current.id, {
        title: title.trim(),
        description: description.trim() === "" ? null : description,
        priority,
        assigneeId: assigneeId === "" ? null : assigneeId,
        dueOn: dueOn === "" ? null : dueOn,
      });
      setError("");
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the task");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <aside
      className="task-detail"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={saving}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header>
        <div>
          <span>
            {sourceName} · {task.number}
          </span>
          <h3 id={titleId}>Task details</h3>
        </div>
        <button
          ref={closeButton}
          type="button"
          disabled={saving}
          onClick={onClose}
          aria-label="Close task details"
        >
          ×
        </button>
      </header>
      <form onSubmit={(event) => void save(event)}>
        {disabled && (
          <p className="task-readonly-banner" role="note">
            This task belongs to an archived channel and is read-only.
          </p>
        )}
        <label>
          Title
          <input
            ref={titleInput}
            value={title}
            disabled={disabled || saving}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={240}
          />
        </label>
        <label>
          Description
          <textarea
            value={description}
            disabled={disabled || saving}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={10_000}
            rows={6}
          />
        </label>
        <div className="task-detail-grid">
          <label>
            Status
            <select
              value={status}
              disabled={disabled || saving}
              onChange={(event) => setStatus(event.target.value as TaskStatus)}
            >
              {COLUMNS.map((column) => (
                <option key={column.status} value={column.status}>
                  {column.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assignee
            <select
              value={assigneeId}
              disabled={disabled || saving}
              onChange={(event) => setAssigneeId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {assignableMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select
              value={priority}
              disabled={disabled || saving}
              onChange={(event) => setPriority(event.target.value as TaskPriority)}
            >
              {PRIORITIES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due date
            <input
              type="date"
              value={dueOn}
              disabled={disabled || saving}
              onChange={(event) => setDueOn(event.target.value)}
            />
          </label>
        </div>
        {task.sourceMessageId !== null && (
          <button
            className="task-source-link"
            type="button"
            disabled={saving}
            onClick={() => onOpenSource(task)}
          >
            Open source message
          </button>
        )}
        {error !== "" && (
          <p className="task-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={disabled || saving || title.trim() === ""}>
            {saving ? "Saving…" : "Save task"}
          </button>
        </footer>
      </form>
    </aside>
  );
}
