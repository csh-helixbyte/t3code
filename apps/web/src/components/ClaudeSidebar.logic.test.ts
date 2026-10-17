import { describe, expect, it } from "vite-plus/test";

import type { ThreadGroup } from "../threadGroupsStore";
import {
  isHiddenSidebarThread,
  partitionClaudeSidebar,
  placeThreadKey,
  sidebarParentThreadId,
  planClaudeSidebarDrop,
  resolveClaudeSidebarDot,
} from "./ClaudeSidebar.logic";

type DotInput = Parameters<typeof resolveClaudeSidebarDot>[0];

const baseStatus: DotInput = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default",
  latestRun: null,
  runtime: null,
};

function completedRun(completedAt: string) {
  return {
    runId: "run-1",
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt,
  } as unknown as DotInput["latestRun"];
}

describe("resolveClaudeSidebarDot", () => {
  it("shows the working dot while the session runs", () => {
    expect(
      resolveClaudeSidebarDot({
        ...baseStatus,
        runtime: { status: "running" } as DotInput["runtime"],
      }),
    ).toBe("working");
  });

  it("asks for attention before anything else", () => {
    expect(
      resolveClaudeSidebarDot({
        ...baseStatus,
        hasPendingApprovals: true,
        runtime: { status: "running" } as DotInput["runtime"],
      }),
    ).toBe("attention");
  });

  it("asks for attention while a question waits, and clears once answered", () => {
    const running = { ...baseStatus, runtime: { status: "running" } as DotInput["runtime"] };
    expect(resolveClaudeSidebarDot({ ...running, hasPendingUserInput: true })).toBe("attention");
    expect(resolveClaudeSidebarDot(running)).toBe("working");
  });

  it("asks for attention while a proposed plan awaits approval, even after a visit", () => {
    const plan = {
      ...baseStatus,
      interactionMode: "plan" as const,
      hasActionableProposedPlan: true,
      latestRun: completedRun("2026-01-01T00:05:00.000Z"),
      lastVisitedAt: "2026-01-01T00:06:00.000Z",
    };
    expect(resolveClaudeSidebarDot(plan)).toBe("attention");
    // Once the plan is implemented or dismissed it is no longer actionable.
    expect(resolveClaudeSidebarDot({ ...plan, hasActionableProposedPlan: false })).toBeNull();
  });

  it("marks a finished delegated subthread unread until it is first opened", () => {
    const subthread = {
      ...baseStatus,
      creationSource: "mcp" as const,
      latestRun: completedRun("2026-01-01T00:05:00.000Z"),
    };
    expect(resolveClaudeSidebarDot(subthread)).toBe("unread");
    expect(
      resolveClaudeSidebarDot({ ...subthread, lastVisitedAt: "2026-01-01T00:06:00.000Z" }),
    ).toBeNull();
    // A thread you started yourself without a visit record stays quiet.
    expect(resolveClaudeSidebarDot({ ...subthread, creationSource: "web" })).toBeNull();
  });

  it("shows the done dot only until the thread is visited", () => {
    const thread = { ...baseStatus, latestRun: completedRun("2026-01-01T00:05:00.000Z") };
    expect(resolveClaudeSidebarDot({ ...thread, lastVisitedAt: "2026-01-01T00:01:00.000Z" })).toBe(
      "unread",
    );
    expect(
      resolveClaudeSidebarDot({ ...thread, lastVisitedAt: "2026-01-01T00:06:00.000Z" }),
    ).toBeNull();
  });
});

describe("partitionClaudeSidebar", () => {
  const thread = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id,
    createdAt,
    latestUserMessageAt: null,
    latestRun: null,
    pinnedAt: null,
    archivedAt: null,
    ...extra,
  });
  const groups: ThreadGroup[] = [{ id: "g1", name: "Onehelia", collapsed: false }];

  it("splits pinned, grouped and recent threads, newest activity first", () => {
    const sections = partitionClaudeSidebar({
      threads: [
        thread("old", "2026-01-01T00:00:00.000Z"),
        thread("new", "2026-01-03T00:00:00.000Z"),
        thread("grouped", "2026-01-02T00:00:00.000Z"),
        thread("pinned", "2026-01-01T00:00:00.000Z", {
          pinnedAt: "2026-01-01T00:00:00.000Z",
        }),
        thread("archived", "2026-01-04T00:00:00.000Z", {
          archivedAt: "2026-01-04T00:00:00.000Z",
        }),
        thread("orphan", "2026-01-02T12:00:00.000Z"),
      ],
      threadKey: (t) => t.id,
      groups,
      groupIdByThreadKey: { grouped: "g1", pinned: "g1", orphan: "deleted-group" },
    });
    expect(sections.pinned.map((t) => t.id)).toEqual(["pinned"]);
    expect(sections.groups[0]!.threads.map((t) => t.id)).toEqual(["grouped"]);
    expect(sections.recents.map((t) => t.id)).toEqual(["new", "orphan", "old"]);
  });

  it("moves settled threads out of every other section", () => {
    const sections = partitionClaudeSidebar({
      threads: [
        thread("settled-pin", "2026-01-02T00:00:00.000Z", {
          pinnedAt: "2026-01-01T00:00:00.000Z",
        }),
        thread("open", "2026-01-01T00:00:00.000Z"),
      ],
      threadKey: (t) => t.id,
      isSettled: (t) => t.id === "settled-pin",
      groups,
      groupIdByThreadKey: {},
    });
    expect(sections.pinned).toEqual([]);
    expect(sections.settled.map((t) => t.id)).toEqual(["settled-pin"]);
    expect(sections.recents.map((t) => t.id)).toEqual(["open"]);
  });

  it("nests forks under their top-most visible ancestor and keeps them with it", () => {
    const parentOf: Record<string, string> = { child: "root", grandchild: "child", lost: "gone" };
    const sections = partitionClaudeSidebar({
      threads: [
        thread("root", "2026-01-01T00:00:00.000Z"),
        thread("child", "2026-01-02T00:00:00.000Z"),
        thread("grandchild", "2026-01-03T00:00:00.000Z"),
        thread("lost", "2026-01-04T00:00:00.000Z"),
      ],
      threadKey: (t) => t.id,
      parentKey: (t) => parentOf[t.id] ?? null,
      groups,
      groupIdByThreadKey: { root: "g1", child: "deleted-group" },
    });
    expect(sections.groups[0]!.threads.map((t) => t.id)).toEqual(["root"]);
    expect(sections.childrenByKey.get("root")!.map((t) => t.id)).toEqual(["grandchild", "child"]);
    expect(sections.recents.map((t) => t.id)).toEqual(["lost"]);
  });

  it("keeps a hand-ordered group in its order, with newcomers on top", () => {
    const sections = partitionClaudeSidebar({
      threads: [
        thread("a", "2026-01-01T00:00:00.000Z"),
        thread("b", "2026-01-02T00:00:00.000Z"),
        thread("c", "2026-01-03T00:00:00.000Z"),
        thread("new1", "2026-01-04T00:00:00.000Z"),
        thread("new2", "2026-01-05T00:00:00.000Z"),
      ],
      threadKey: (t) => t.id,
      groups,
      groupIdByThreadKey: { a: "g1", b: "g1", c: "g1", new1: "g1", new2: "g1" },
      threadOrderByGroupId: { g1: ["a", "gone", "c", "b"] },
    });
    expect(sections.groups[0]!.threads.map((t) => t.id)).toEqual(["new2", "new1", "a", "c", "b"]);
  });

  it("leaves hidden groups and their threads out instead of moving them to Recents", () => {
    const sections = partitionClaudeSidebar({
      threads: [
        thread("kept", "2026-01-01T00:00:00.000Z"),
        thread("loose", "2026-01-02T00:00:00.000Z"),
      ],
      threadKey: (t) => t.id,
      groups: [...groups, { id: "g2", name: "Proposals", collapsed: false, hidden: true }],
      groupIdByThreadKey: { kept: "g2" },
    });
    expect(sections.groups.map(({ group }) => group.id)).toEqual(["g1"]);
    expect(sections.recents.map((t) => t.id)).toEqual(["loose"]);
  });
});

describe("placeThreadKey", () => {
  it("drops a thread before or after its anchor, from inside or outside the group", () => {
    expect(placeThreadKey(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(placeThreadKey(["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"]);
    expect(placeThreadKey(["a", "b"], "x", "a", "after")).toEqual(["a", "x", "b"]);
  });

  it("keeps the shown order when the anchor is missing or the thread itself", () => {
    expect(placeThreadKey(["a", "b"], "a", "a", "after")).toEqual(["a", "b"]);
    expect(placeThreadKey(["a", "b"], "x", "gone", "before")).toEqual(["a", "b"]);
  });
});

describe("planClaudeSidebarDrop", () => {
  const base = { isPinned: false, isSettled: false, currentGroupId: null as string | null };
  const none = { pin: false, unpin: false, settle: false, unsettle: false };

  it("pins on Pinned, unpins and regroups elsewhere, and ignores no-op drops", () => {
    expect(
      planClaudeSidebarDrop({ ...base, currentGroupId: "g1", target: { kind: "pinned" } }),
    ).toEqual({ ...none, pin: true, groupId: null });
    expect(
      planClaudeSidebarDrop({ ...base, isPinned: true, target: { kind: "group", groupId: "g1" } }),
    ).toEqual({ ...none, unpin: true, groupId: "g1" });
    expect(planClaudeSidebarDrop({ ...base, target: { kind: "recents" } })).toBeNull();
    expect(
      planClaudeSidebarDrop({ ...base, isPinned: true, target: { kind: "pinned" } }),
    ).toBeNull();
  });

  it("settles on Settled and un-settles when dragged back out", () => {
    expect(
      planClaudeSidebarDrop({ ...base, currentGroupId: "g1", target: { kind: "settled" } }),
    ).toEqual({ ...none, settle: true, groupId: null });
    expect(
      planClaudeSidebarDrop({ ...base, isSettled: true, target: { kind: "settled" } }),
    ).toBeNull();
    expect(
      planClaudeSidebarDrop({ ...base, isSettled: true, target: { kind: "recents" } }),
    ).toEqual({ ...none, unsettle: true, groupId: null });
    expect(
      planClaudeSidebarDrop({
        ...base,
        isSettled: true,
        isPinned: true,
        target: { kind: "pinned" },
      }),
    ).toEqual({ ...none, unsettle: true, groupId: null });
  });
});

describe("sidebar lineage", () => {
  type Input = Parameters<typeof sidebarParentThreadId>[0];
  const lineage = (relationshipToParent: "fork" | "subagent" | null) =>
    ({
      parentThreadId: relationshipToParent ? "parent" : null,
      relationshipToParent,
      rootThreadId: "parent",
    }) as Input["lineage"];
  const thread = (input: Partial<Input> & Pick<Input, "lineage">) =>
    ({ forkedFrom: null, ...input }) as Input;

  it("shows delegated subthreads under their spawner and hides provider subagents", () => {
    const delegated = thread({ lineage: lineage("subagent"), creationSource: "mcp" });
    const native = thread({ lineage: lineage("subagent"), creationSource: "provider" });
    const unknown = thread({ lineage: lineage("subagent") });
    expect(isHiddenSidebarThread(delegated)).toBe(false);
    expect(sidebarParentThreadId(delegated)).toBe("parent");
    expect(isHiddenSidebarThread(native)).toBe(true);
    expect(isHiddenSidebarThread(unknown)).toBe(true);
  });

  it("nests forks and leaves plain threads at the top level", () => {
    expect(sidebarParentThreadId(thread({ lineage: lineage("fork") }))).toBe("parent");
    expect(sidebarParentThreadId(thread({ lineage: lineage(null) }))).toBeNull();
    expect(isHiddenSidebarThread(thread({ lineage: lineage(null) }))).toBe(false);
  });
});
