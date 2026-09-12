import { useMemo, useSyncExternalStore } from "react";
import type { WorkspaceRuntimeState } from "./workspace-runtime";

export interface WorkspaceStore {
  readonly state: WorkspaceRuntimeState;
  subscribe(listener: (state: WorkspaceRuntimeState) => void): () => void;
}

/** Equal selections retain their previous identity across unrelated store changes. */
export function createWorkspaceSelection<T>(
  store: WorkspaceStore,
  select: (state: WorkspaceRuntimeState) => T,
  equal: (left: T, right: T) => boolean = Object.is,
) {
  let source = store.state;
  let snapshot = select(source);
  const getSnapshot = (): T => {
    if (source !== store.state) {
      source = store.state;
      const next = select(source);
      if (!equal(snapshot, next)) snapshot = next;
    }
    return snapshot;
  };
  return {
    getSnapshot,
    subscribe: (notify: () => void): (() => void) => {
      let previous = getSnapshot();
      return store.subscribe(() => {
        const next = getSnapshot();
        if (Object.is(previous, next)) return;
        previous = next;
        notify();
      });
    },
  };
}

export function useWorkspaceSelection<T>(
  store: WorkspaceStore,
  select: (state: WorkspaceRuntimeState) => T,
  equal: (left: T, right: T) => boolean = Object.is,
): T {
  const selection = useMemo(
    () => createWorkspaceSelection(store, select, equal),
    [store, select, equal],
  );
  return useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
}

export type WorkspaceView = Omit<WorkspaceRuntimeState, "typingByConversation">;

export function selectWorkspaceView(state: WorkspaceRuntimeState): WorkspaceView {
  const { typingByConversation, ...view } = state;
  void typingByConversation;
  return view;
}

export function equalWorkspaceView(left: WorkspaceView, right: WorkspaceView): boolean {
  return Object.keys(left).every((key) =>
    Object.is(left[key as keyof WorkspaceView], right[key as keyof WorkspaceView]),
  );
}
