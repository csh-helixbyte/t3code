import { describe, expect, it } from "vite-plus/test";

import { reorderThreadGroups } from "./threadGroupsStore";

describe("reorderThreadGroups", () => {
  const groups = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const ids = (list: readonly { id: string }[]) => list.map((group) => group.id);

  it("moves a group up or down into the target slot", () => {
    expect(ids(reorderThreadGroups(groups, "c", 0))).toEqual(["c", "a", "b"]);
    expect(ids(reorderThreadGroups(groups, "a", 2))).toEqual(["b", "c", "a"]);
    expect(ids(reorderThreadGroups(groups, "a", 1))).toEqual(["b", "a", "c"]);
  });

  it("returns the same list for no-op moves and clamps out-of-range targets", () => {
    expect(reorderThreadGroups(groups, "b", 1)).toBe(groups);
    expect(reorderThreadGroups(groups, "missing", 0)).toBe(groups);
    expect(reorderThreadGroups(groups, "a", -1)).toBe(groups);
    expect(ids(reorderThreadGroups(groups, "a", 9))).toEqual(["b", "c", "a"]);
  });
});
