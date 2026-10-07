import { describe, expect, it } from "vite-plus/test";

import { previewEditCommandForKey } from "./PreviewEditing.ts";

const chord = (
  key: string,
  modifiers: Partial<Record<"meta" | "control" | "alt" | "shift", boolean>> = {},
  code = `Key${key.toUpperCase()}`,
) => ({
  key,
  code,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...modifiers,
});

describe("previewEditCommandForKey", () => {
  it("maps Command chords on macOS", () => {
    expect(previewEditCommandForKey(chord("a", { meta: true }), "darwin")).toBe("selectAll");
    expect(previewEditCommandForKey(chord("c", { meta: true }), "darwin")).toBe("copy");
    expect(previewEditCommandForKey(chord("x", { meta: true }), "darwin")).toBe("cut");
    expect(previewEditCommandForKey(chord("v", { meta: true }), "darwin")).toBe("paste");
    expect(previewEditCommandForKey(chord("z", { meta: true }), "darwin")).toBe("undo");
    expect(previewEditCommandForKey(chord("z", { meta: true, shift: true }), "darwin")).toBe(
      "redo",
    );
    expect(
      previewEditCommandForKey(
        chord("◊", { meta: true, alt: true, shift: true }, "KeyV"),
        "darwin",
      ),
    ).toBe("pasteAndMatchStyle");
  });

  it("ignores Control chords on macOS and Command chords elsewhere", () => {
    expect(previewEditCommandForKey(chord("v", { control: true }), "darwin")).toBeNull();
    expect(previewEditCommandForKey(chord("v", { meta: true }), "linux")).toBeNull();
    expect(previewEditCommandForKey(chord("v", { control: true }), "linux")).toBe("paste");
    expect(previewEditCommandForKey(chord("y", { control: true }), "win32")).toBe("redo");
    expect(previewEditCommandForKey(chord("y", { control: true }), "linux")).toBeNull();
  });

  it("leaves other shortcuts to the page", () => {
    expect(previewEditCommandForKey(chord("r", { meta: true }), "darwin")).toBeNull();
    expect(previewEditCommandForKey(chord("a", { meta: true, shift: true }), "darwin")).toBeNull();
    expect(previewEditCommandForKey(chord("v"), "darwin")).toBeNull();
  });
});
