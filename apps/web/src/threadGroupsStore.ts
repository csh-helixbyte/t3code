import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

// User-made sidebar groups (HelixByte fork). Client-only by design: groups
// live in this browser's localStorage and never touch the server or its
// database, so another device or client starts with no groups.
const THREAD_GROUPS_STORAGE_KEY = "t3code:sidebar:thread-groups";

export interface ThreadGroup {
  readonly id: string;
  readonly name: string;
  readonly collapsed: boolean;
}

/**
 * Moves a group to `toIndex` in the list, shifting the rest. Returns the same
 * array when nothing moves so callers can skip a store write.
 */
export function reorderThreadGroups<T extends { readonly id: string }>(
  groups: readonly T[],
  groupId: string,
  toIndex: number,
): readonly T[] {
  const from = groups.findIndex((group) => group.id === groupId);
  const to = Math.max(0, Math.min(groups.length - 1, toIndex));
  if (from === -1 || from === to) return groups;
  const next = groups.filter((group) => group.id !== groupId);
  next.splice(to, 0, groups[from]!);
  return next;
}

interface ThreadGroupsState {
  groups: ThreadGroup[];
  /** Scoped thread key → group id. Threads without an entry sit in Recents. */
  groupIdByThreadKey: Record<string, string>;
  pinnedCollapsed: boolean;
  recentsCollapsed: boolean;
  settledCollapsed: boolean;
}

interface ThreadGroupsStore extends ThreadGroupsState {
  createGroup: (name: string) => string;
  renameGroup: (groupId: string, name: string) => void;
  deleteGroup: (groupId: string) => void;
  toggleGroup: (groupId: string) => void;
  moveGroup: (groupId: string, toIndex: number) => void;
  moveThreadToGroup: (threadKey: string, groupId: string | null) => void;
  togglePinned: () => void;
  toggleRecents: () => void;
  toggleSettled: () => void;
}

export const useThreadGroupsStore = create<ThreadGroupsStore>()(
  persist(
    (set, get) => ({
      groups: [],
      groupIdByThreadKey: {},
      pinnedCollapsed: false,
      recentsCollapsed: false,
      settledCollapsed: true,
      createGroup: (name) => {
        // Local ids only need to be unique within this browser's list.
        const id = `group-${Date.now().toString(36)}-${get().groups.length}`;
        set((state) => ({ groups: [...state.groups, { id, name, collapsed: false }] }));
        return id;
      },
      renameGroup: (groupId, name) =>
        set((state) => ({
          groups: state.groups.map((group) => (group.id === groupId ? { ...group, name } : group)),
        })),
      // Deleting a group never touches its threads: they fall back to Recents.
      deleteGroup: (groupId) =>
        set((state) => ({
          groups: state.groups.filter((group) => group.id !== groupId),
          groupIdByThreadKey: Object.fromEntries(
            Object.entries(state.groupIdByThreadKey).filter(([, id]) => id !== groupId),
          ),
        })),
      toggleGroup: (groupId) =>
        set((state) => ({
          groups: state.groups.map((group) =>
            group.id === groupId ? { ...group, collapsed: !group.collapsed } : group,
          ),
        })),
      moveGroup: (groupId, toIndex) =>
        set((state) => {
          const groups = reorderThreadGroups(state.groups, groupId, toIndex);
          return groups === state.groups ? state : { groups: [...groups] };
        }),
      moveThreadToGroup: (threadKey, groupId) =>
        set((state) => {
          const { [threadKey]: _previous, ...rest } = state.groupIdByThreadKey;
          return {
            groupIdByThreadKey: groupId === null ? rest : { ...rest, [threadKey]: groupId },
          };
        }),
      togglePinned: () => set((state) => ({ pinnedCollapsed: !state.pinnedCollapsed })),
      toggleRecents: () => set((state) => ({ recentsCollapsed: !state.recentsCollapsed })),
      toggleSettled: () => set((state) => ({ settledCollapsed: !state.settledCollapsed })),
    }),
    {
      name: THREAD_GROUPS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state): ThreadGroupsState => ({
        groups: state.groups,
        groupIdByThreadKey: state.groupIdByThreadKey,
        pinnedCollapsed: state.pinnedCollapsed,
        recentsCollapsed: state.recentsCollapsed,
        settledCollapsed: state.settledCollapsed,
      }),
    },
  ),
);
