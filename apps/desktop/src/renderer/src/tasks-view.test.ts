// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task, User } from "@hmm-chat/contracts";

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
  render(
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
  return { onCreate, onUpdate, onMove, onOpenSource };
}

afterEach(() => {
  cleanup();
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

    fireEvent.click(screen.getAllByTitle("Move right")[0] as HTMLElement);
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(todo.id, "in_progress", null));
  });

  it("persists List mode and opens task details plus the linked source message", () => {
    const { onOpenSource } = renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByRole("region", { name: "Kanban board" })).toBeNull();
    expect(window.localStorage.getItem(`hype-comms:tasks-view:${CONVERSATION_ID}`)).toBe("list");

    fireEvent.click(screen.getByRole("button", { name: /Write launch brief/ }));
    expect(screen.getByRole("complementary", { name: "Task 1" })).toBeTruthy();
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
});
