// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task, User } from "@hype-comms/contracts";

import { TasksView } from "./tasks-view";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const PEER_ID = "10000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000003";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000004";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000005";
const NOW = "2026-08-05T12:00:00.000Z";

const members: readonly User[] = [
  {
    id: USER_ID,
    kind: "human",
    username: "morgan",
    displayName: "Morgan",
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: PEER_ID,
    kind: "human",
    username: "alex",
    displayName: "Alex",
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

function task(
  id: string,
  number: string,
  title: string,
  status: Task["status"],
  rank: string,
): Task {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    conversationId: CONVERSATION_ID,
    number,
    version: 1,
    title,
    description: null,
    status,
    priority: status === "todo" ? "high" : "none",
    assigneeId: USER_ID,
    dueOn: null,
    sourceMessageId: status === "todo" ? MESSAGE_ID : null,
    rank,
    createdBy: USER_ID,
    completedAt: status === "done" ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const todo = task(
  "10000000-0000-4000-8000-000000000011",
  "1",
  "Write launch brief",
  "todo",
  "1024",
);
const doing = task(
  "10000000-0000-4000-8000-000000000012",
  "2",
  "Review rollout",
  "in_progress",
  "1024",
);
const done = task(
  "10000000-0000-4000-8000-000000000013",
  "3",
  "Publish retrospective",
  "done",
  "1024",
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const storedPreferences = new Map<string, string>();

beforeEach(() => {
  storedPreferences.clear();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storedPreferences.get(key) ?? null,
      setItem: (key: string, value: string) => storedPreferences.set(key, value),
      clear: () => storedPreferences.clear(),
    },
  });
});

function renderTasks(overrides: Partial<ComponentProps<typeof TasksView>> = {}) {
  const onCreate = vi.fn<NonNullable<ComponentProps<typeof TasksView>["onCreate"]>>(
    async () => todo,
  );
  const onUpdate = vi.fn<NonNullable<ComponentProps<typeof TasksView>["onUpdate"]>>(
    async () => todo,
  );
  const onMove = vi.fn<NonNullable<ComponentProps<typeof TasksView>["onMove"]>>(async () => todo);
  const onOpenSource = vi.fn<NonNullable<ComponentProps<typeof TasksView>["onOpenSource"]>>();
  const rendered = render(
    createElement(TasksView, {
      conversationId: CONVERSATION_ID,
      personal: false,
      archived: false,
      currentUserId: USER_ID,
      members,
      assignableMembers: () => members,
      tasks: [todo, doing],
      busy: false,
      error: null,
      conversationName: () => "#general",
      isConversationArchived: () => false,
      onCreate,
      onUpdate,
      onMove,
      onOpenSource,
      ...overrides,
    }),
  );
  return { onCreate, onUpdate, onMove, onOpenSource, ...rendered };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TasksView", () => {
  it("defaults channels to Kanban, creates rich tasks, and offers keyboard moves", async () => {
    const { onCreate, onMove } = renderTasks();

    expect(screen.getByRole("region", { name: "Kanban board" })).toBeTruthy();
    expect(screen.getByText("To do")).toBeTruthy();
    expect(screen.getByText("In progress")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), {
      target: { value: "Publish release notes" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Assignee" }), {
      target: { value: PEER_ID },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), {
      target: { value: "urgent" },
    });
    fireEvent.change(screen.getByLabelText("Due date"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        title: "Publish release notes",
        description: null,
        priority: "urgent",
        assigneeId: PEER_ID,
        dueOn: "2026-08-20",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Move Write launch brief to In progress" }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(todo.id, "in_progress", null));
  });

  it("persists List mode and opens task details plus the linked source message", () => {
    const { onOpenSource } = renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByRole("region", { name: "Kanban board" })).toBeNull();
    expect(window.localStorage.getItem(`hype-comms:tasks-view:${CONVERSATION_ID}`)).toBe("list");

    fireEvent.click(screen.getByRole("button", { name: /Write launch brief/ }));
    expect(screen.getByRole("dialog", { name: "Task details" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open source message" }));
    expect(onOpenSource).toHaveBeenCalledWith(todo);
  });

  it("defaults My Tasks to List and can include assigned work from channel boards", () => {
    const assigned = { ...doing, conversationId: "10000000-0000-4000-8000-000000000099" };
    renderTasks({ personal: true, tasks: [todo, assigned] });

    expect(screen.queryByRole("region", { name: "Kanban board" })).toBeNull();
    expect(screen.getByText("My Tasks")).toBeTruthy();
    expect(screen.getByText("Review rollout")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include assigned work" }));
    expect(screen.queryByText("Review rollout")).toBeNull();
  });

  it("disables boundary moves and names every available move for its task and destination", () => {
    renderTasks({ tasks: [todo, doing, done] });

    expect(screen.getByRole("button", { name: "Move Write launch brief to To do" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: "Move Write launch brief earlier in To do" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Move Write launch brief later in To do" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Move Write launch brief to In progress" }),
    ).toHaveProperty("disabled", false);
    expect(
      screen.getByRole("button", { name: "Move Publish retrospective to Done" }),
    ).toHaveProperty("disabled", true);
  });

  it("prevents duplicate creates while exposing pending copy", async () => {
    const pending = deferred<Task>();
    const onCreate = vi.fn(async () => pending.promise);
    renderTasks({ onCreate });
    const input = screen.getByRole("textbox", { name: "Task title" });
    const form = input.closest("form");
    expect(form).not.toBeNull();

    fireEvent.change(input, { target: { value: "Publish release notes" } });
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(form?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "Adding task…" })).toHaveProperty("disabled", true);

    await act(async () => pending.resolve(todo));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add task" })).toHaveProperty("disabled", true),
    );
  });

  it("prevents concurrent moves and exposes the moving card state", async () => {
    const pending = deferred<Task>();
    const onMove = vi.fn(async () => pending.promise);
    renderTasks({ onMove });
    const moveRight = screen.getByRole("button", {
      name: "Move Write launch brief to In progress",
    });

    fireEvent.click(moveRight);
    fireEvent.click(moveRight);

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Moving task…")).toBeTruthy();
    expect(screen.getByText("Moving task…").closest("article")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Move Review rollout to Done" })).toHaveProperty(
      "disabled",
      true,
    );

    await act(async () => pending.resolve({ ...todo, status: "in_progress", version: 2 }));
    await waitFor(() => expect(screen.queryByText("Moving task…")).toBeNull());
  });

  it("renders accessible status, priority, assignee, and due-state metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00-07:00"));
    const overdue = { ...todo, dueOn: "2026-08-06" };
    const upcoming = { ...doing, dueOn: "2026-08-20", priority: "urgent" as const };
    const completed = { ...done, dueOn: "2026-08-01" };
    renderTasks({ tasks: [overdue, upcoming, completed] });

    expect(screen.getByLabelText("Priority: High")).toBeTruthy();
    expect(screen.getByLabelText("Priority: Urgent")).toBeTruthy();
    expect(screen.getAllByLabelText("Assignee: Morgan")).toHaveLength(3);
    expect(screen.getByLabelText("Due Aug 6, overdue")).toBeTruthy();
    expect(screen.getByLabelText("Due Aug 20, upcoming")).toBeTruthy();
    expect(screen.getByLabelText("Due Aug 1, completed")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Write launch brief Status: To do/ })).toBeTruthy();
  });

  it("shows a truthful loading state before an empty task collection is available", () => {
    renderTasks({ tasks: [], busy: true });

    expect(screen.getByRole("status").textContent).toContain("Loading tasks…");
    expect(screen.queryByRole("region", { name: "Kanban board" })).toBeNull();
    expect(screen.queryByText("No tasks yet")).toBeNull();
  });

  it("distinguishes empty, failed, and archived collections", () => {
    const { unmount } = renderTasks({ tasks: [] });
    expect(screen.getByText("No tasks yet")).toBeTruthy();
    unmount();

    const failed = renderTasks({ tasks: [], error: "The board is unavailable" });
    expect(screen.getByRole("alert").textContent).toContain("The board is unavailable");
    expect(screen.getByText("Tasks could not be loaded")).toBeTruthy();
    failed.unmount();

    renderTasks({ tasks: [], archived: true });
    expect(screen.getByText("No archived tasks")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("Tasks are read-only");
    expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
  });

  it("makes archived task details read-only", () => {
    renderTasks({ archived: true, tasks: [todo] });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: /Write launch brief/ }));

    const dialog = screen.getByRole("dialog", { name: "Task details" });
    expect(dialog.textContent).toContain("belongs to an archived channel");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Save task" })).toHaveProperty("disabled", true);
  });

  it("focuses the detail title, closes on Escape, and restores focus", () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const row = screen.getByRole("button", { name: /Write launch brief/ });
    row.focus();
    fireEvent.click(row);

    const dialog = screen.getByRole("dialog", { name: "Task details" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Title" }));
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Task details" })).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("prevents duplicate detail saves and announces saving progress", async () => {
    const pending = deferred<Task>();
    const onUpdate = vi.fn(async () => pending.promise);
    renderTasks({ onUpdate });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: /Write launch brief/ }));
    const dialog = screen.getByRole("dialog", { name: "Task details" });
    const form = screen.getByRole("textbox", { name: "Title" }).closest("form");
    expect(form).not.toBeNull();

    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);

    pending.resolve({ ...todo, version: 2 });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task details" })).toBeNull());
  });
});
