import { describe, expect, it } from "vite-plus/test";

import type { ThreadGroup } from "../threadGroupsStore";
import { partitionClaudeSidebar, resolveClaudeSidebarDot } from "./ClaudeSidebar.logic";

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
});
