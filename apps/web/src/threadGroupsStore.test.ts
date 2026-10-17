import { describe, expect, it } from "vite-plus/test";

import { reorderThreadGroups, useThreadGroupsStore } from "./threadGroupsStore";

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

describe("thread order within a group", () => {
  it("forgets a thread's place when it leaves, and the whole order when the group goes", () => {
    const store = useThreadGroupsStore.getState();
    const groupId = store.createGroup("Cerev");
    const otherId = store.createGroup("Onehelia");
    for (const key of ["a", "b", "c"]) store.moveThreadToGroup(key, groupId);
    store.setGroupThreadOrder(groupId, ["c", "a", "b"]);

    store.moveThreadToGroup("a", groupId);
    expect(useThreadGroupsStore.getState().threadOrderByGroupId[groupId]).toEqual(["c", "a", "b"]);
    store.moveThreadToGroup("a", otherId);
    expect(useThreadGroupsStore.getState().threadOrderByGroupId[groupId]).toEqual(["c", "b"]);

    store.deleteGroup(groupId);
    expect(useThreadGroupsStore.getState().threadOrderByGroupId[groupId]).toBeUndefined();
  });
});
