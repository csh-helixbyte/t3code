/**
 * Native editing shortcuts in preview guests.
 *
 * Shared by the main process and the guest preload, so it must stay free of
 * Electron and Effect imports.
 */

export type PreviewEditCommand =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "pasteAndMatchStyle"
  | "selectAll";

export const PREVIEW_EDIT_COMMANDS: ReadonlySet<string> = new Set<PreviewEditCommand>([
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "pasteAndMatchStyle",
  "selectAll",
]);

export interface PreviewEditingKey {
  readonly key: string;
  readonly code: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** The edit a key chord asks for on this platform, or null for anything else. */
export const previewEditCommandForKey = (
  input: PreviewEditingKey,
  platform: string,
): PreviewEditCommand | null => {
  const isMac = platform === "darwin";
  if (isMac ? !input.meta || input.control : !input.control || input.meta) return null;

  const key = input.key.toLowerCase();
  // Option changes the DOM key for macOS Paste and Match Style (for example, to ◊).
  if (isMac && input.alt && input.shift && input.code === "KeyV") return "pasteAndMatchStyle";
  if (key === "v" && input.shift) return input.alt === isMac ? "pasteAndMatchStyle" : null;
  if (input.alt) return null;
  if (key === "z") {
    if (!input.shift) return "undo";
    return platform !== "win32" ? "redo" : null;
  }
  if (input.shift) return null;
  if (key === "a") return "selectAll";
  if (key === "c") return "copy";
  if (key === "v") return "paste";
  if (key === "x") return "cut";
  if (key === "y" && platform === "win32") return "redo";
  return null;
};
