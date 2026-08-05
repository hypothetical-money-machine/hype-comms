import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";

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

function dueLabel(dueOn: string | null): string | null {
  if (dueOn === null) return null;
  const [year, month, day] = dueOn.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return dueOn;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(year, month - 1, day),
  );
}

function TaskCard({
  task,
  members,
  sourceName,
  disabled,
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
  readonly onSelect: () => void;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onDropBefore: (event: DragEvent<HTMLElement>) => void;
  readonly onMoveEarlier: () => void;
  readonly onMoveLater: () => void;
  readonly onMoveLeft: () => void;
  readonly onMoveRight: () => void;
}) {
  const due = dueLabel(task.dueOn);
  return (
    <article
      className={`task-card priority-${task.priority}`}
      draggable={!disabled}
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDropBefore}
    >
      <button className="task-card-main" type="button" onClick={onSelect}>
        <span className="task-key">
          {sourceName} · {task.number}
        </span>
        <strong>{task.title}</strong>
        <span className="task-card-meta">
          <span>{memberName(members, task.assigneeId)}</span>
          {task.priority !== "none" && <span>{priorityLabel(task.priority)}</span>}
          {due !== null && <span>{due}</span>}
        </span>
      </button>
      {!disabled && (
        <div className="task-card-moves" aria-label={`Move ${task.title}`}>
          <button type="button" title="Move left" onClick={onMoveLeft}>
            ←
          </button>
          <button type="button" title="Move up" onClick={onMoveEarlier}>
            ↑
          </button>
          <button type="button" title="Move down" onClick={onMoveLater}>
            ↓
          </button>
          <button type="button" title="Move right" onClick={onMoveRight}>
            →
          </button>
        </div>
      )}
    </article>
  );
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
    if (trimmed === "") return;
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
    }
  };

  const move = async (
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null,
  ): Promise<void> => {
    if (archived || (personal && isConversationArchived(task.conversationId))) return;
    try {
      await onMove(task.id, status, beforeTaskId);
      setFormError("");
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Could not move the task");
    }
  };

  const adjacentStatus = (status: TaskStatus, offset: -1 | 1): TaskStatus => {
    const index = COLUMNS.findIndex((column) => column.status === status);
    return COLUMNS[Math.max(0, Math.min(COLUMNS.length - 1, index + offset))]?.status ?? status;
  };

  return (
    <section className="tasks-view">
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

      {!archived && (
        <form className="task-quick-add" onSubmit={(event) => void submitTask(event)}>
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
          <button type="submit" disabled={busy || title.trim() === ""}>
            Add task
          </button>
        </form>
      )}

      {(error !== null || formError !== "") && (
        <p className="task-error" role="alert">
          {formError || error}
        </p>
      )}

      {mode === "board" ? (
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
                  {columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      members={members}
                      sourceName={conversationName(task.conversationId)}
                      disabled={archived || isConversationArchived(task.conversationId)}
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
                        const siblings = columnTasks.filter(
                          (candidate) => candidate.conversationId === task.conversationId,
                        );
                        const siblingIndex = siblings.findIndex(
                          (candidate) => candidate.id === task.id,
                        );
                        const before = siblings[siblingIndex - 1];
                        if (before !== undefined) void move(task, column.status, before.id);
                      }}
                      onMoveLater={() => {
                        const siblings = columnTasks.filter(
                          (candidate) => candidate.conversationId === task.conversationId,
                        );
                        const siblingIndex = siblings.findIndex(
                          (candidate) => candidate.id === task.id,
                        );
                        const afterNext = siblings[siblingIndex + 2];
                        void move(task, column.status, afterNext?.id ?? null);
                      }}
                      onMoveLeft={() => void move(task, adjacentStatus(task.status, -1), null)}
                      onMoveRight={() => void move(task, adjacentStatus(task.status, 1), null)}
                    />
                  ))}
                  {columnTasks.length === 0 && <p className="kanban-empty">Drop a task here</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="task-list-view">
          {visibleTasks.map((task) => (
            <button key={task.id} type="button" onClick={() => setSelectedTaskId(task.id)}>
              <span className={`task-check status-${task.status}`} aria-hidden="true">
                {task.status === "done" ? "✓" : ""}
              </span>
              <span className="task-list-copy">
                <strong>{task.title}</strong>
                <small>
                  {conversationName(task.conversationId)} · {memberName(members, task.assigneeId)}
                </small>
              </span>
              <span className="task-list-detail">
                {task.priority !== "none" && priorityLabel(task.priority)}
                {dueLabel(task.dueOn) ?? ""}
              </span>
            </button>
          ))}
          {visibleTasks.length === 0 && (
            <div className="task-empty-state">
              <h4>Nothing on the board</h4>
              <p>Add the first task when work emerges from the conversation.</p>
            </div>
          )}
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

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setPriority(task.priority);
    setAssigneeId(task.assigneeId ?? "");
    setDueOn(task.dueOn ?? "");
    setStatus(task.status);
  }, [task]);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
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
    }
  };

  return (
    <aside className="task-detail" aria-label={`Task ${task.number}`}>
      <header>
        <div>
          <span>
            {sourceName} · {task.number}
          </span>
          <h3>Task details</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Close task details">
          ×
        </button>
      </header>
      <form onSubmit={(event) => void save(event)}>
        <label>
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} />
        </label>
        <label>
          Description
          <textarea
            value={description}
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
            <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
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
            <input type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
          </label>
        </div>
        {task.sourceMessageId !== null && (
          <button className="task-source-link" type="button" onClick={() => onOpenSource(task)}>
            Open source message
          </button>
        )}
        {error !== "" && (
          <p className="task-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={disabled || title.trim() === ""}>
            Save task
          </button>
        </footer>
      </form>
    </aside>
  );
}
