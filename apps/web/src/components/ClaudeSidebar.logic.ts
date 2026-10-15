import type { SidebarThreadSummary } from "../types";
import type { ThreadGroup } from "../threadGroupsStore";
import { resolveSidebarThreadStatus, resolveThreadStatusPill } from "./Sidebar.logic";

/**
 * The one status mark a row carries, Claude desktop style:
 * - working: a dimmed gray dot that pulses while the agent runs
 * - attention: the agent is blocked on the user (approval or question)
 * - failed: the session errored
 * - unread: the agent finished (or proposed a plan) since you last looked
 */
export type ClaudeSidebarDot = "working" | "attention" | "failed" | "unread";

export function resolveClaudeSidebarDot(
  thread: Parameters<typeof resolveThreadStatusPill>[0]["thread"],
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
    case "Completed":
      return "unread";
    default:
      return null;
  }
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
}

/**
 * Splits threads into Pinned, the user's groups, and Recents. Pinned wins
 * over a group; a thread assigned to a group that no longer exists falls
 * back to Recents. Every section lists most recent activity first.
 */
export function partitionClaudeSidebar<
  T extends Pick<
    SidebarThreadSummary,
    "createdAt" | "latestUserMessageAt" | "latestRun" | "pinnedAt" | "archivedAt"
  >,
>(input: {
  threads: readonly T[];
  threadKey: (thread: T) => string;
  groups: readonly ThreadGroup[];
  groupIdByThreadKey: Readonly<Record<string, string>>;
}): ClaudeSidebarSections<T> {
  const byActivity = (left: T, right: T) => threadActivityMs(right) - threadActivityMs(left);
  const sorted = input.threads.filter((thread) => thread.archivedAt == null).toSorted(byActivity);
  const groupThreads = new Map(input.groups.map((group) => [group.id, [] as T[]]));
  const pinned: T[] = [];
  const recents: T[] = [];
  for (const thread of sorted) {
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
  };
}
