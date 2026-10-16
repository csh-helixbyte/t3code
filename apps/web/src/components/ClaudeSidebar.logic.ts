import type { SidebarThreadSummary } from "../types";
import type { ThreadGroup } from "../threadGroupsStore";
import {
  getSidebarForkParentThreadId,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
} from "./Sidebar.logic";

/**
 * The one status mark a row carries, Claude desktop style:
 * - working: a dimmed gray dot that pulses while the agent runs
 * - attention: the agent is blocked on the user (approval, question, or a
 *   proposed plan awaiting approval)
 * - failed: the session errored
 * - unread: the agent finished since you last looked
 */
export type ClaudeSidebarDot = "working" | "attention" | "failed" | "unread";

/**
 * A delegated subthread is started by the agent, so it may finish without you
 * ever opening it; with no visit to compare against it still counts as unread.
 */
export function resolveClaudeSidebarDot(
  thread: Parameters<typeof resolveThreadStatusPill>[0]["thread"] &
    Partial<Pick<SidebarThreadSummary, "creationSource">>,
): ClaudeSidebarDot | null {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input") return "attention";
  if (status === "failed" || status === "limited") return "failed";
  switch (resolveThreadStatusPill({ thread })?.label) {
    case "Working":
    case "Connecting":
    case "Waiting":
      return "working";
    case "Plan Ready":
      return "attention";
    case "Completed":
      return "unread";
    default:
      return thread.creationSource === "mcp" &&
        !thread.lastVisitedAt &&
        thread.latestRun?.completedAt
        ? "unread"
        : null;
  }
}

type LineageInput = Pick<SidebarThreadSummary, "lineage" | "forkedFrom" | "creationSource">;

/**
 * A provider's own subagents (Claude's Agent tool, Codex/Cursor native ones)
 * stay out of the sidebar, as in the stock one: the Agents panel lists them
 * and they can't take messages. T3 delegated subthreads (`delegate_task`,
 * creationSource "mcp") are real conversations and show. A server that does
 * not send creationSource keeps every subagent hidden.
 */
export function isHiddenSidebarThread(thread: LineageInput): boolean {
  return thread.lineage.relationshipToParent === "subagent" && thread.creationSource !== "mcp";
}

/** The thread a row nests under: a fork's source, or a delegated subthread's spawner. */
export function sidebarParentThreadId(thread: LineageInput) {
  if (thread.lineage.relationshipToParent === "subagent") {
    return thread.creationSource === "mcp" ? thread.lineage.parentThreadId : null;
  }
  return getSidebarForkParentThreadId(thread);
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Last time anything happened in the conversation; Recents sorts by it. */
export function threadActivityMs(
  thread: Pick<SidebarThreadSummary, "createdAt" | "latestUserMessageAt" | "latestRun">,
): number {
  return Math.max(
    timestampMs(thread.createdAt),
    timestampMs(thread.latestUserMessageAt),
    timestampMs(thread.latestRun?.requestedAt),
    timestampMs(thread.latestRun?.completedAt),
  );
}

export interface ClaudeSidebarSections<T> {
  readonly pinned: T[];
  readonly groups: { readonly group: ThreadGroup; readonly threads: T[] }[];
  readonly recents: T[];
  /** Settled threads, hidden behind the collapsed Settled section. */
  readonly settled: T[];
  /** Top-level thread key → the threads nested under it, newest first. */
  readonly childrenByKey: ReadonlyMap<string, T[]>;
}

/**
 * Splits threads into Pinned, the user's groups, Recents and Settled.
 * Settled wins over everything (as in the stock sidebar), then Pinned, then a
 * group; a thread assigned to a group that no longer exists falls
 * back to Recents. A thread with a visible parent (`parentKey`) nests one
 * level deep under its top-most visible ancestor and follows it between
 * sections. Every list is most recent activity first.
 */
export function partitionClaudeSidebar<
  T extends Pick<
    SidebarThreadSummary,
    "createdAt" | "latestUserMessageAt" | "latestRun" | "pinnedAt" | "archivedAt"
  >,
>(input: {
  threads: readonly T[];
  threadKey: (thread: T) => string;
  parentKey?: (thread: T) => string | null;
  isSettled?: (thread: T) => boolean;
  groups: readonly ThreadGroup[];
  groupIdByThreadKey: Readonly<Record<string, string>>;
}): ClaudeSidebarSections<T> {
  const byActivity = (left: T, right: T) => threadActivityMs(right) - threadActivityMs(left);
  const sorted = input.threads.filter((thread) => thread.archivedAt == null).toSorted(byActivity);
  const byKey = new Map(sorted.map((thread) => [input.threadKey(thread), thread] as const));
  const topLevelKeyOf = (thread: T): string => {
    let key = input.threadKey(thread);
    const seen = new Set<string>([key]);
    for (;;) {
      const parent = input.parentKey?.(byKey.get(key)!) ?? null;
      if (parent === null || !byKey.has(parent) || seen.has(parent)) return key;
      seen.add(parent);
      key = parent;
    }
  };
  const childrenByKey = new Map<string, T[]>();
  const topLevel: T[] = [];
  for (const thread of sorted) {
    const rootKey = topLevelKeyOf(thread);
    if (rootKey === input.threadKey(thread)) {
      topLevel.push(thread);
      continue;
    }
    const siblings = childrenByKey.get(rootKey);
    if (siblings) siblings.push(thread);
    else childrenByKey.set(rootKey, [thread]);
  }
  const groupThreads = new Map(input.groups.map((group) => [group.id, [] as T[]]));
  const pinned: T[] = [];
  const recents: T[] = [];
  const settled: T[] = [];
  for (const thread of topLevel) {
    if (input.isSettled?.(thread)) {
      settled.push(thread);
      continue;
    }
    if (thread.pinnedAt != null) {
      pinned.push(thread);
      continue;
    }
    const groupId = input.groupIdByThreadKey[input.threadKey(thread)];
    const bucket = groupId === undefined ? undefined : groupThreads.get(groupId);
    (bucket ?? recents).push(thread);
  }
  return {
    pinned,
    groups: input.groups.map((group) => ({ group, threads: groupThreads.get(group.id)! })),
    recents,
    settled,
    childrenByKey,
  };
}

/** Where a dragged top-level thread was dropped. */
export type ClaudeSidebarDropTarget =
  | { readonly kind: "pinned" }
  | { readonly kind: "recents" }
  | { readonly kind: "settled" }
  | { readonly kind: "group"; readonly groupId: string };

export function claudeSidebarDropId(target: ClaudeSidebarDropTarget): string {
  return target.kind === "group" ? `group:${target.groupId}` : target.kind;
}

export function parseClaudeSidebarDropId(id: string): ClaudeSidebarDropTarget | null {
  if (id === "pinned" || id === "recents" || id === "settled") return { kind: id };
  if (id.startsWith("group:")) return { kind: "group", groupId: id.slice("group:".length) };
  return null;
}

/**
 * What a drop changes. Pinning and settling are server state, grouping is
 * local, and a thread sits in exactly one section: dropping on Settled
 * settles it, dropping anywhere else un-settles it, leaving Pinned unpins it,
 * and entering Pinned, Recents or Settled clears its group.
 */
export function planClaudeSidebarDrop(input: {
  isPinned: boolean;
  isSettled: boolean;
  currentGroupId: string | null;
  target: ClaudeSidebarDropTarget;
}): {
  pin: boolean;
  unpin: boolean;
  settle: boolean;
  unsettle: boolean;
  groupId: string | null;
} | null {
  const { isPinned, isSettled, currentGroupId, target } = input;
  if (target.kind === "settled") {
    return isSettled
      ? null
      : { pin: false, unpin: false, settle: true, unsettle: false, groupId: null };
  }
  const unsettle = isSettled;
  if (target.kind === "pinned") {
    return isPinned && !isSettled
      ? null
      : { pin: !isPinned, unpin: false, settle: false, unsettle, groupId: null };
  }
  const groupId = target.kind === "group" ? target.groupId : null;
  if (!isPinned && !isSettled && currentGroupId === groupId) return null;
  return { pin: false, unpin: isPinned, settle: false, unsettle, groupId };
}
