import { useAtomValue } from "@effect/atom-react";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";
import {
  DndContext,
  DragOverlay,
  defaultDropAnimationSideEffects,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { readLocalApi } from "../localApi";
import { useUiStateStore } from "../uiStateStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useProjects, useThreadShells } from "../state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { useThreadGroupsStore, type ThreadGroup } from "../threadGroupsStore";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../composerDraftStore";
import { cn } from "~/lib/utils";
import {
  resolveAdjacentThreadId,
  resolveThreadLastVisitedAt,
  shouldCreateNewThreadInCurrentProject,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import {
  claudeSidebarDropId,
  isHiddenSidebarThread,
  parseClaudeSidebarDropId,
  sidebarParentThreadId,
  partitionClaudeSidebar,
  planClaudeSidebarDrop,
  resolveClaudeSidebarDot,
  type ClaudeSidebarDot,
  type ClaudeSidebarDropTarget,
} from "./ClaudeSidebar.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../providerInstances";
import {
  useEnvironmentIdentities,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../state/environments";

// HelixByte fork: a Claude desktop style sidebar. One line per thread with a
// trailing status dot, sectioned into Pinned, the user's own groups (kept in
// localStorage, see threadGroupsStore) and Recents.

const RECENTS_PAGE_SIZE = 40;
const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();

function threadKeyOf(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function parentKeyOf(thread: SidebarThreadSummary): string | null {
  const parentId = sidebarParentThreadId(thread);
  return parentId ? scopedThreadKey(scopeThreadRef(thread.environmentId, parentId)) : null;
}

function toastFailure(title: string, result: AtomCommandResult<unknown, unknown>): void {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

const dotClassName: Record<ClaudeSidebarDot, string> = {
  // Gray with a soft glow; status-pulse steps its opacity instead of tweening
  // every frame, so a sidebar full of working threads stays cheap to paint.
  working:
    "text-muted-foreground bg-current shadow-[0_0_4px_currentColor] motion-safe:animate-status-pulse",
  unread: "text-info bg-current",
  attention: "text-warning bg-current",
  failed: "text-destructive bg-current",
};

const dotLabel: Record<ClaudeSidebarDot, string> = {
  working: "Working",
  unread: "Done",
  attention: "Needs your input",
  failed: "Failed",
};

function StatusDot({ dot }: { dot: ClaudeSidebarDot }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={dotLabel[dot]}
            className={cn("size-1.5 shrink-0 rounded-full", dotClassName[dot])}
          />
        }
      />
      <TooltipPopup side="top">{dotLabel[dot]}</TooltipPopup>
    </Tooltip>
  );
}

const rowClassName =
  "group/claude-row flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none select-none transition-colors duration-100 focus-visible:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50";

// On drop the lifted row glides into wherever its row now renders (the new
// group, or back home while a server pin/settle is in flight) instead of
// vanishing. The source row stays hidden until the overlay lands on it.
const dropAnimation: DropAnimation = {
  duration: 200,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
};

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// Pointer drags start after a short move so a click stays a click; the click
// that ends a drag is swallowed so dropping never also opens the thread.
let suppressRowClickUntil = 0;

function InlineNameInput(props: {
  initial: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const doneRef = useRef(false);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) props.onCommit(value);
    else props.onCancel();
  };
  return (
    <input
      autoFocus
      aria-label={props.ariaLabel}
      value={value}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className="h-6 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1.5 text-sm text-foreground outline-none"
    />
  );
}

/** Where a thread runs, shown on rows off this machine. */
interface ThreadRowPlace {
  readonly label: string;
  readonly machine: React.ComponentProps<typeof EnvironmentMachineIcon>["kind"];
}

interface ThreadRowBodyProps {
  thread: SidebarThreadSummary;
  threadKey: string;
  /** Provider instances of the thread's own environment (ids collide across environments). */
  providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
  place: ThreadRowPlace | undefined;
  isRenaming: boolean;
  jumpLabel: string | null;
  onMenu?: ((threadKey: string, position: { x: number; y: number }) => void) | undefined;
  onRenameCommit?: ((thread: SidebarThreadSummary, title: string) => void) | undefined;
  onRenameCancel?: (() => void) | undefined;
}

// The thread's provider, leading the row (with its instance badge when
// several instances of one driver are configured).
function ThreadProviderMark(props: {
  thread: SidebarThreadSummary;
  providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
}) {
  const instanceId =
    props.thread.runtime?.providerInstanceId ?? props.thread.modelSelection.instanceId;
  const entry = props.providerEntries.get(instanceId);
  if (entry === undefined) return null;
  return (
    <span className="inline-flex shrink-0 items-center">
      <ProviderInstanceIcon
        driverKind={entry.driverKind}
        displayName={entry.displayName}
        accentColor={entry.accentColor}
        acpRegistryAgentId={entry.acpRegistryAgentId}
        acpRegistryIconUrl={entry.acpRegistryIconUrl}
        showBadge={shouldShowInstanceBadge(entry, props.providerEntries.values())}
        iconClassName="size-3.5 opacity-70"
        badgeClassName="right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-5xs"
      />
    </span>
  );
}

// Title plus a fixed trailing slot: the status dot at rest, the "…" actions
// button on hover or keyboard focus, so the title never shifts.
function ThreadRowBody(props: ThreadRowBodyProps) {
  const { thread, threadKey, onMenu } = props;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const dot = resolveClaudeSidebarDot({ ...thread, lastVisitedAt });
  const showMenuButton = onMenu !== undefined && !props.isRenaming;
  return (
    <>
      <ThreadProviderMark thread={thread} providerEntries={props.providerEntries} />
      {props.isRenaming ? (
        <InlineNameInput
          initial={thread.title}
          ariaLabel="Thread title"
          onCommit={(title) => props.onRenameCommit?.(thread, title)}
          onCancel={() => props.onRenameCancel?.()}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      )}
      {props.place ? (
        <span
          role="img"
          aria-label={`Runs on ${props.place.label}`}
          className="inline-flex shrink-0 text-sidebar-muted-foreground/70"
        >
          <EnvironmentMachineIcon aria-hidden kind={props.place.machine} className="size-3.5" />
        </span>
      ) : null}
      {props.jumpLabel ? (
        <span className="shrink-0 rounded-sm bg-sidebar-row-hover px-1 text-2xs text-muted-foreground">
          {props.jumpLabel}
        </span>
      ) : (
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          {dot ? (
            <span
              className={cn(
                "flex",
                showMenuButton &&
                  "group-focus-within/claude-row:opacity-0 group-hover/claude-row:opacity-0 group-data-menu-open/claude-row:opacity-0",
              )}
            >
              <StatusDot dot={dot} />
            </span>
          ) : null}
          {showMenuButton ? (
            <button
              type="button"
              aria-label={`Actions for ${thread.title}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                onMenu(threadKey, { x: rect.left, y: rect.bottom + 4 });
              }}
              onKeyDown={(event) => event.stopPropagation()}
              className="absolute inset-0 inline-flex cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground opacity-0 transition-opacity duration-100 group-focus-within/claude-row:opacity-100 group-hover/claude-row:opacity-100 group-data-menu-open/claude-row:bg-sidebar-border/60 group-data-menu-open/claude-row:text-sidebar-foreground group-data-menu-open/claude-row:opacity-100 hover:bg-sidebar-border/60 hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50"
            >
              <MoreHorizontalIcon className="size-3.5" />
            </button>
          ) : null}
        </span>
      )}
    </>
  );
}

/** Child rows hang off a hairline that ends in a rounded elbow at the last one. */
type ThreadRowGuide = "middle" | "last" | null;

const ClaudeThreadRow = memo(function ClaudeThreadRow(
  props: ThreadRowBodyProps & {
    isActive: boolean;
    isMenuOpen: boolean;
    guide: ThreadRowGuide;
    draggable: boolean;
    onOpen: (thread: SidebarThreadSummary) => void;
    onMenu: (threadKey: string, position: { x: number; y: number }) => void;
    children?: React.ReactNode;
  },
) {
  const { thread, threadKey, onOpen, onMenu } = props;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: threadKey,
    disabled: !props.draggable || props.isRenaming,
  });
  return (
    <li className="relative list-none">
      {props.guide === "middle" ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-[15px] w-px bg-sidebar-muted-foreground/35"
        />
      ) : props.guide === "last" ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 left-[15px] h-1/2 w-2 rounded-bl-md border-b border-l border-sidebar-muted-foreground/35"
        />
      ) : null}
      <div
        ref={setNodeRef}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-current={props.isActive ? "page" : undefined}
        data-testid="claude-sidebar-thread-row"
        data-thread-key={threadKey}
        data-menu-open={props.isMenuOpen ? "" : undefined}
        className={cn(
          rowClassName,
          "pr-1.5",
          props.guide !== null && "ml-6 w-auto",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover",
          props.isMenuOpen && !props.isActive && "bg-sidebar-row-hover",
          isDragging && "opacity-40",
        )}
        onClick={() => {
          if (props.isRenaming || Date.now() < suppressRowClickUntil) return;
          onOpen(thread);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(threadKey, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (props.isRenaming) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(thread);
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu(threadKey, { x: rect.right, y: rect.bottom });
          }
        }}
      >
        <ThreadRowBody {...props} />
      </div>
      {props.children}
    </li>
  );
});

// Wraps a section so a dragged thread can land anywhere on it, header included.
/**
 * Animates a section's body open and closed by its height (a 0fr/1fr grid
 * row, so no measuring). Only a toggle animates; content changes inside an
 * open section don't. Closed content unmounts once the close finishes, so a
 * long collapsed list costs nothing.
 */
function Collapse(props: { open: boolean; children: React.ReactNode }) {
  const { open } = props;
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [previousOpen, setPreviousOpen] = useState(open);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    // Opening mounts at 0fr; the frame below expands it so it transitions.
    setExpanded(false);
    if (open) setMounted(true);
    else if (prefersReducedMotion()) setMounted(false);
  }
  useEffect(() => {
    if (!open || expanded) return;
    const frame = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, [expanded, open]);
  if (!mounted) return null;
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) setMounted(false);
      }}
    >
      <div className="min-h-0 overflow-hidden">{props.children}</div>
    </div>
  );
}

function DropSection(props: {
  target: ClaudeSidebarDropTarget;
  label: string;
  dragActive: boolean;
  className?: string | undefined;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: claudeSidebarDropId(props.target) });
  return (
    <section
      ref={setNodeRef}
      aria-label={props.label}
      data-drop-id={claudeSidebarDropId(props.target)}
      className={cn(
        "rounded-lg pb-0.5 transition-colors duration-100",
        props.dragActive && isOver && "bg-sidebar-row-hover/70 ring-1 ring-sidebar-border",
        props.className,
      )}
    >
      {props.children}
    </section>
  );
}

function SectionHeader(props: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: (() => void) | undefined;
  addLabel?: string | undefined;
  onMenu?: ((position: { x: number; y: number }) => void) | undefined;
  renaming?: { onCommit: (name: string) => void; onCancel: () => void } | undefined;
}) {
  return (
    <div
      className="group/claude-section mt-3 flex h-7 items-center gap-1 pr-1.5 pl-2.5 text-xs text-sidebar-muted-foreground/70"
      onContextMenu={(event) => {
        if (!props.onMenu) return;
        event.preventDefault();
        props.onMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {props.renaming ? (
        <InlineNameInput
          initial={props.label}
          ariaLabel="Group name"
          onCommit={props.renaming.onCommit}
          onCancel={props.renaming.onCancel}
        />
      ) : (
        <button
          type="button"
          aria-expanded={!props.collapsed}
          onClick={props.onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm text-left outline-none hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-transform duration-100",
              !props.collapsed && "rotate-90",
            )}
          />
          <span className="min-w-0 truncate">{props.label}</span>
        </button>
      )}
      {props.onMenu ? (
        <button
          type="button"
          aria-label={`${props.label} options`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            props.onMenu?.({ x: rect.left, y: rect.bottom });
          }}
          className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm opacity-0 group-hover/claude-section:opacity-100 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </button>
      ) : null}
      {props.onAdd ? (
        <button
          type="button"
          aria-label={props.addLabel}
          onClick={props.onAdd}
          className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <PlusIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function NavItem(props: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string | null | undefined;
  onClick: (event: ReactMouseEvent) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={cn(
        rowClassName,
        "text-sidebar-foreground/90 hover:bg-sidebar-row-hover disabled:cursor-default disabled:opacity-50",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{props.icon}</span>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.shortcut ? (
        <span className="shrink-0 text-2xs text-muted-foreground/70">{props.shortcut}</span>
      ) : null}
    </button>
  );
}

// Unsent drafts with content, one line each. The open draft is left out so
// typing never repaints the list.
const DraftRows = memo(function DraftRows(props: {
  routeDraftId: string | null;
  onOpen: (draftId: DraftId) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const drafts = useMemo(
    () =>
      Object.entries(draftThreadsByThreadKey)
        .flatMap(([draftKey, session]) => {
          if (session.promotedTo != null || draftKey === props.routeDraftId) return [];
          const composer = draftsByThreadKey[draftKey];
          if (!composer || !composerDraftHasUserContent(composer)) return [];
          const preview =
            replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
              .trim()
              .split("\n", 1)[0] || "Draft with attachments";
          return [{ draftId: DraftId.make(draftKey), preview, createdAt: session.createdAt }];
        })
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [draftThreadsByThreadKey, draftsByThreadKey, props.routeDraftId],
  );
  return drafts.map((draft) => (
    <li key={draft.draftId} className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Unsent draft: ${draft.preview}`}
        className={cn(rowClassName, "text-sidebar-foreground/70 hover:bg-sidebar-row-hover")}
        onClick={() => props.onOpen(draft.draftId)}
        onKeyDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onOpen(draft.draftId);
          }
        }}
      >
        <SquarePenIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate italic">{draft.preview}</span>
        <button
          type="button"
          aria-label="Discard draft"
          onClick={(event) => {
            event.stopPropagation();
            releaseComposerDraftUploads(draft.draftId);
            clearDraftThread(draft.draftId);
          }}
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm opacity-0 group-hover/claude-row:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          <XIcon className="size-3" />
        </button>
      </div>
    </li>
  ));
});

type ThreadMenuAction =
  | "rename"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "mark-unread"
  | "move:recents"
  | "move:new"
  | `move:${string}`
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete";

export default function ClaudeSidebar() {
  const projects = useProjects();
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const {
    pinThread,
    unpinThread,
    settleThread,
    unsettleThread,
    confirmAndUnpinThread,
    archiveThread,
    deleteThread,
    markThreadUnread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const newThreadContext = useHandleNewThread();
  const { copyToClipboard } = useCopyToClipboard<{ label: string; value: string }>({
    onCopy: ({ label, value }) =>
      toastManager.add({ type: "success", title: `${label} copied`, description: value }),
  });

  const groups = useThreadGroupsStore((s) => s.groups);
  const groupIdByThreadKey = useThreadGroupsStore((s) => s.groupIdByThreadKey);
  const pinnedCollapsed = useThreadGroupsStore((s) => s.pinnedCollapsed);
  const recentsCollapsed = useThreadGroupsStore((s) => s.recentsCollapsed);
  const createGroup = useThreadGroupsStore((s) => s.createGroup);
  const renameGroup = useThreadGroupsStore((s) => s.renameGroup);
  const deleteGroup = useThreadGroupsStore((s) => s.deleteGroup);
  const toggleGroup = useThreadGroupsStore((s) => s.toggleGroup);
  const moveThreadToGroup = useThreadGroupsStore((s) => s.moveThreadToGroup);
  const togglePinned = useThreadGroupsStore((s) => s.togglePinned);
  const toggleRecents = useThreadGroupsStore((s) => s.toggleRecents);
  const settledCollapsed = useThreadGroupsStore((s) => s.settledCollapsed);
  const toggleSettled = useThreadGroupsStore((s) => s.toggleSettled);

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  // The row whose actions menu is open keeps its hover look until it closes.
  const [menuThreadKey, setMenuThreadKey] = useState<string | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  // A group created this moment is discarded if its first naming is cancelled.
  const [newGroupId, setNewGroupId] = useState<string | null>(null);
  const startNewGroup = useCallback(
    (threadKey?: string) => {
      const groupId = createGroup("New group");
      if (threadKey) moveThreadToGroup(threadKey, groupId);
      setNewGroupId(groupId);
      setRenamingGroupId(groupId);
    },
    [createGroup, moveThreadToGroup],
  );
  const [recentsLimit, setRecentsLimit] = useState(RECENTS_PAGE_SIZE);
  const [settledLimit, setSettledLimit] = useState(RECENTS_PAGE_SIZE);

  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;

  // Settled needs the server capability, like the stock sidebar: without it
  // the user could not un-settle, so such threads never classify as settled.
  const isThreadSettled = useCallback(
    (thread: SidebarThreadSummary) =>
      thread.settledOverride === "settled" &&
      serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement === true,
    [serverConfigs],
  );
  const sections = useMemo(() => {
    const partition = partitionClaudeSidebar({
      threads: threads.filter((thread) => !isHiddenSidebarThread(thread)),
      threadKey: threadKeyOf,
      parentKey: parentKeyOf,
      isSettled: isThreadSettled,
      groups,
      groupIdByThreadKey,
    });
    // Most recently settled first, as in the stock Settled shelf.
    return { ...partition, settled: sortSettledThreads(partition.settled) };
  }, [groupIdByThreadKey, groups, isThreadSettled, threads]);
  const visibleSettled = sections.settled.slice(0, settledLimit);
  const visibleRecents = sections.recents.slice(0, recentsLimit);
  // Keyboard jump and traversal follow what is on screen, top to bottom.
  const orderedThreads = useMemo(() => {
    const withChildren = (rows: readonly SidebarThreadSummary[]) =>
      rows.flatMap((thread) => [
        thread,
        ...(sections.childrenByKey.get(threadKeyOf(thread)) ?? []),
      ]);
    return [
      ...(pinnedCollapsed ? [] : withChildren(sections.pinned)),
      ...sections.groups.flatMap(({ group, threads: groupThreads }) =>
        group.collapsed ? [] : withChildren(groupThreads),
      ),
      ...(recentsCollapsed ? [] : withChildren(sections.recents.slice(0, recentsLimit))),
      ...(settledCollapsed ? [] : withChildren(sections.settled.slice(0, settledLimit))),
    ];
  }, [pinnedCollapsed, recentsCollapsed, recentsLimit, sections, settledCollapsed, settledLimit]);
  const orderedThreadKeys = useMemo(() => orderedThreads.map(threadKeyOf), [orderedThreads]);
  const threadByKey = useMemo(
    () => new Map(threads.map((thread) => [threadKeyOf(thread), thread] as const)),
    [threads],
  );
  // Threads resolve provider instances from their own environment's config:
  // default instance ids are driver slugs, so a flat map would collide.
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers, config.settings] as const,
        ),
      ),
    [serverConfigs],
  );
  const environmentIdentities = useEnvironmentIdentities();
  const environmentMachines = useEnvironmentMachines();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Only threads on another machine (a Mac mini, a server) carry its icon;
  // this machine is the default and would just repeat on every row. With no
  // primary (the hosted app) every environment is remote and shows.
  const placeByEnvironment = useMemo(
    () =>
      new Map<string, ThreadRowPlace>(
        environmentIdentities
          .filter((environment) => environment.environmentId !== primaryEnvironmentId)
          .map((environment) => [
            environment.environmentId,
            {
              label: environment.label,
              machine: environmentMachines.get(environment.environmentId) ?? "server",
            },
          ]),
      ),
    [environmentIdentities, environmentMachines, primaryEnvironmentId],
  );
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;

  const closeMobile = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const navigateToThread = useCallback(
    (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => {
      closeMobile();
      return router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [closeMobile, router],
  );
  const openThread = useCallback(
    (thread: SidebarThreadSummary) => void navigateToThread(thread),
    [navigateToThread],
  );
  const openDraft = useCallback(
    (draftId: DraftId) => {
      closeMobile();
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [closeMobile, router],
  );

  const handleNewThread = useCallback(
    (event?: ReactMouseEvent) => {
      closeMobile();
      if (shouldCreateNewThreadInCurrentProject(event?.shiftKey ?? false, projects.length)) {
        void startNewThreadFromContext({
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          handleNewThread: newThreadContext.handleNewThread,
        });
        return;
      }
      openCommandPalette({ open: "new-thread-in" });
    },
    [closeMobile, newThreadContext, projects.length],
  );

  const commitThreadRename = useCallback(
    (thread: SidebarThreadSummary, title: string) => {
      setRenamingThreadKey(null);
      const trimmed = title.trim();
      if (trimmed.length === 0 || trimmed === thread.title) return;
      void updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, title: trimmed },
      }).then((result) => toastFailure("Failed to rename thread", result));
    },
    [updateThreadMetadata],
  );
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);

  const handleThreadContextMenu = useCallback(
    (threadKey: string, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const thread = threadByKeyRef.current.get(threadKey);
        if (!api || !thread) return;
        setMenuThreadKey(threadKey);
        const threadRef: ScopedThreadRef = scopeThreadRef(thread.environmentId, thread.id);
        const supportsPinning =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning === true;
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const isPinned = thread.pinnedAt != null;
        const isSettled = isThreadSettled(thread);
        const currentGroupId = useThreadGroupsStore.getState().groupIdByThreadKey[threadKey];
        const workspacePath =
          thread.worktreePath ??
          projects.find(
            (project) =>
              project.environmentId === thread.environmentId && project.id === thread.projectId,
          )?.workspaceRoot ??
          null;
        const clicked = await settlePromise(() =>
          api.contextMenu.show<ThreadMenuAction>(
            [
              { id: "rename", label: "Rename" },
              ...(supportsPinning
                ? [{ id: isPinned ? "unpin" : "pin", label: isPinned ? "Unpin" : "Pin" } as const]
                : []),
              ...(supportsSettlement
                ? [
                    {
                      id: isSettled ? "unsettle" : "settle",
                      label: isSettled ? "Un-settle" : "Settle",
                    } as const,
                  ]
                : []),
              ...(thread.latestRun?.completedAt
                ? [{ id: "mark-unread", label: "Mark as unread" } as const]
                : []),
              {
                id: "move:recents",
                label: "Move to group",
                separatorBefore: true,
                children: [
                  ...groups.map((group) => ({
                    id: `move:${group.id}` as const,
                    label: group.name,
                    checked: currentGroupId === group.id,
                  })),
                  ...(currentGroupId
                    ? [{ id: "move:recents" as const, label: "Remove from group" }]
                    : []),
                  { id: "move:new", label: "New group…", separatorBefore: groups.length > 0 },
                ],
              },
              {
                id: "copy-path",
                label: "Copy path",
                separatorBefore: true,
                disabled: !workspacePath,
              },
              ...(thread.branch ? [{ id: "copy-branch", label: "Copy branch name" } as const] : []),
              { id: "copy-thread-id", label: "Copy thread ID" },
              { id: "archive", label: "Archive", separatorBefore: true },
              { id: "delete", label: "Delete", destructive: true },
            ],
            position,
          ),
        );
        setMenuThreadKey(null);
        if (clicked._tag === "Failure" || !clicked.value) return;
        const action = clicked.value;
        switch (action) {
          case "rename":
            setRenamingThreadKey(threadKey);
            return;
          case "pin":
            toastFailure("Failed to pin thread", await pinThread(threadRef));
            return;
          case "unpin":
            toastFailure("Failed to unpin thread", await confirmAndUnpinThread(threadRef));
            return;
          case "settle":
            toastFailure("Failed to settle thread", await settleThread(threadRef));
            return;
          case "unsettle":
            toastFailure("Failed to un-settle thread", await unsettleThread(threadRef));
            return;
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "move:recents":
            moveThreadToGroup(threadKey, null);
            return;
          case "move:new":
            startNewGroup(threadKey);
            return;
          case "copy-path":
            if (workspacePath)
              copyToClipboard(workspacePath, { label: "Path", value: workspacePath });
            return;
          case "copy-branch":
            if (thread.branch) {
              copyToClipboard(thread.branch, { label: "Branch", value: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyToClipboard(thread.id, { label: "Thread ID", value: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            toastFailure("Failed to archive thread", await archiveThread(threadRef));
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            toastFailure("Failed to delete thread", await deleteThread(threadRef));
            return;
          }
          default:
            moveThreadToGroup(threadKey, action.slice("move:".length));
        }
      })();
    },
    [
      archiveThread,
      confirmAndUnpinThread,
      confirmThreadArchive,
      confirmThreadDelete,
      copyToClipboard,
      deleteThread,
      groups,
      markThreadUnread,
      moveThreadToGroup,
      pinThread,
      projects,
      serverConfigs,
      isThreadSettled,
      settleThread,
      startNewGroup,
      unsettleThread,
    ],
  );

  const handleGroupMenu = useCallback(
    (group: ThreadGroup, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show<"rename" | "new" | "delete">(
            [
              { id: "rename", label: "Rename group" },
              { id: "new", label: "New group" },
              { id: "delete", label: "Delete group", destructive: true, separatorBefore: true },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        if (clicked.value === "rename") setRenamingGroupId(group.id);
        if (clicked.value === "new") startNewGroup();
        if (clicked.value === "delete") deleteGroup(group.id);
      })();
    },
    [deleteGroup, startNewGroup],
  );
  const handleRecentsMenu = useCallback(
    (position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show<"new">([{ id: "new", label: "New group" }], position),
        );
        if (clicked._tag === "Success" && clicked.value === "new") {
          startNewGroup();
        }
      })();
    },
    [startNewGroup],
  );

  // Thread jump (mod+1..9) and previous/next traversal, as in the stock sidebar.
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const go = (targetKey: string | null) => {
        const target = targetKey ? threadByKeyRef.current.get(targetKey) : undefined;
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        void navigateToThread(target);
      };
      const direction = threadTraversalDirectionFromCommand(command);
      if (direction !== null) {
        go(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) go(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [keybindings, navigateToThread, orderedThreadKeys, routeTerminalOpen, routeThreadKey]);

  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
      },
    },
  );
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);
  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);

  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [draggingThreadKey, setDraggingThreadKey] = useState<string | null>(null);
  // The overlay keeps showing the last lifted row after the drop so the drop
  // animation has something to move; DragOverlay hides it once it lands.
  const [overlayThreadKey, setOverlayThreadKey] = useState<string | null>(null);
  const overlayThread = overlayThreadKey ? threadByKey.get(overlayThreadKey) : undefined;
  // Nothing above the dragged row may change size while a drag runs: the
  // drag library treats any scroll or shift as pointer movement, and the
  // lifted row would drift away from the cursor.
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingThreadKey(String(event.active.id));
    setOverlayThreadKey(String(event.active.id));
  }, []);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingThreadKey(null);
      suppressRowClickUntil = Date.now() + 250;
      const threadKey = String(event.active.id);
      const thread = threadByKeyRef.current.get(threadKey);
      const target = event.over ? parseClaudeSidebarDropId(String(event.over.id)) : null;
      if (!thread || !target) return;
      const plan = planClaudeSidebarDrop({
        isPinned: thread.pinnedAt != null,
        isSettled: isThreadSettled(thread),
        currentGroupId: useThreadGroupsStore.getState().groupIdByThreadKey[threadKey] ?? null,
        target,
      });
      if (!plan) return;
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      if ((plan.pin || plan.unpin) && capabilities?.threadPinning !== true) {
        toastManager.add({ type: "warning", title: "This environment can't pin threads" });
        return;
      }
      if (plan.settle && capabilities?.threadSettlement !== true) {
        toastManager.add({ type: "warning", title: "This environment can't settle threads" });
        return;
      }
      moveThreadToGroup(threadKey, plan.groupId);
      void (async () => {
        if (plan.unsettle) {
          toastFailure("Failed to un-settle thread", await unsettleThread(threadRef));
        }
        if (plan.settle) toastFailure("Failed to settle thread", await settleThread(threadRef));
        if (plan.pin) toastFailure("Failed to pin thread", await pinThread(threadRef));
        if (plan.unpin) toastFailure("Failed to unpin thread", await unpinThread(threadRef));
      })();
    },
    [
      isThreadSettled,
      moveThreadToGroup,
      pinThread,
      serverConfigs,
      settleThread,
      unpinThread,
      unsettleThread,
    ],
  );
  const dragActive = draggingThreadKey !== null;

  const renderRow = (
    thread: SidebarThreadSummary,
    guide: ThreadRowGuide,
    children?: React.ReactNode,
  ) => {
    const threadKey = threadKeyOf(thread);
    return (
      <ClaudeThreadRow
        key={threadKey}
        thread={thread}
        threadKey={threadKey}
        providerEntries={
          providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
        }
        place={placeByEnvironment.get(thread.environmentId)}
        guide={guide}
        draggable={guide === null}
        isActive={routeThreadKey === threadKey}
        isMenuOpen={menuThreadKey === threadKey}
        isRenaming={renamingThreadKey === threadKey}
        jumpLabel={showThreadJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
        onOpen={openThread}
        onMenu={handleThreadContextMenu}
        onRenameCommit={commitThreadRename}
        onRenameCancel={cancelThreadRename}
      >
        {children}
      </ClaudeThreadRow>
    );
  };
  const renderRows = (rows: readonly SidebarThreadSummary[]) =>
    rows.map((thread) => {
      const children = sections.childrenByKey.get(threadKeyOf(thread));
      return renderRow(
        thread,
        null,
        children ? (
          <ul>
            {children.map((child, index) =>
              renderRow(child, index === children.length - 1 ? "last" : "middle"),
            )}
          </ul>
        ) : null,
      );
    });

  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    shortcutLabelForCommand(keybindings, "chat.newLocal");
  const searchShortcutLabel = shortcutLabelForCommand(keybindings, "commandPalette.toggle");

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <TooltipProvider delay={300} closeDelay={0}>
        <SidebarContent className="min-h-full">
          <DndContext
            sensors={dragSensors}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDraggingThreadKey(null)}
          >
            <SidebarGroup className="flex-1" role="presentation">
              <div className="relative flex flex-col gap-px">
                <NavItem
                  icon={<PlusIcon className="size-4" />}
                  label="New thread"
                  shortcut={newThreadShortcutLabel}
                  onClick={handleNewThread}
                  disabled={projects.length === 0}
                />
                <NavItem
                  icon={<SearchIcon className="size-4" />}
                  label="Search"
                  shortcut={searchShortcutLabel}
                  onClick={() => {
                    closeMobile();
                    openCommandPalette();
                  }}
                />
                {dragActive && sections.pinned.length === 0 ? (
                  // Floats over the nav rows instead of joining the list, so
                  // offering it never shifts the rows under the pointer.
                  <DropSection
                    target={{ kind: "pinned" }}
                    label="Pinned"
                    dragActive={dragActive}
                    className="absolute inset-0 flex items-center justify-center border border-dashed border-sidebar-border bg-sidebar pb-0 text-xs text-muted-foreground"
                  >
                    Drop here to pin
                  </DropSection>
                ) : null}
              </div>

              {sections.pinned.length > 0 ? (
                <DropSection target={{ kind: "pinned" }} label="Pinned" dragActive={dragActive}>
                  <SectionHeader
                    label="Pinned"
                    collapsed={pinnedCollapsed}
                    onToggle={togglePinned}
                  />
                  <Collapse open={!pinnedCollapsed}>
                    <ul className="flex flex-col gap-px">{renderRows(sections.pinned)}</ul>
                  </Collapse>
                </DropSection>
              ) : null}

              {sections.groups.map(({ group, threads: groupThreads }) => (
                <DropSection
                  key={group.id}
                  target={{ kind: "group", groupId: group.id }}
                  label={group.name}
                  dragActive={dragActive}
                >
                  <SectionHeader
                    label={group.name}
                    collapsed={group.collapsed}
                    onToggle={() => toggleGroup(group.id)}
                    onMenu={(position) => handleGroupMenu(group, position)}
                    renaming={
                      renamingGroupId === group.id
                        ? {
                            onCommit: (name) => {
                              setRenamingGroupId(null);
                              setNewGroupId(null);
                              if (name.trim()) renameGroup(group.id, name.trim());
                            },
                            onCancel: () => {
                              setRenamingGroupId(null);
                              if (newGroupId === group.id) deleteGroup(group.id);
                              setNewGroupId(null);
                            },
                          }
                        : undefined
                    }
                  />
                  <Collapse open={!group.collapsed}>
                    {groupThreads.length > 0 ? (
                      <ul className="flex flex-col gap-px">{renderRows(groupThreads)}</ul>
                    ) : (
                      <p className="px-2.5 py-1 text-xs text-muted-foreground/50">
                        Drag a thread here
                      </p>
                    )}
                  </Collapse>
                </DropSection>
              ))}

              <DropSection target={{ kind: "recents" }} label="Recents" dragActive={dragActive}>
                <SectionHeader
                  label="Recents"
                  collapsed={recentsCollapsed}
                  onToggle={toggleRecents}
                  onMenu={handleRecentsMenu}
                  onAdd={projects.length > 0 ? () => handleNewThread() : undefined}
                  addLabel="New thread from Recents"
                />
                <Collapse open={!recentsCollapsed}>
                  <ul className="flex flex-col gap-px">
                    <DraftRows routeDraftId={routeDraftId} onOpen={openDraft} />
                    {renderRows(visibleRecents)}
                    {sections.recents.length > recentsLimit ? (
                      <li className="list-none">
                        <button
                          type="button"
                          onClick={() => setRecentsLimit((limit) => limit + RECENTS_PAGE_SIZE)}
                          className={cn(
                            rowClassName,
                            "text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover",
                          )}
                        >
                          Show more
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </Collapse>
              </DropSection>

              {sections.settled.length > 0 || dragActive ? (
                <DropSection target={{ kind: "settled" }} label="Settled" dragActive={dragActive}>
                  <SectionHeader
                    label={
                      sections.settled.length > 0
                        ? `Settled (${sections.settled.length})`
                        : "Settled"
                    }
                    collapsed={settledCollapsed && !dragActive}
                    onToggle={toggleSettled}
                  />
                  {dragActive && sections.settled.length === 0 ? (
                    <p className="mx-1 rounded-md border border-dashed border-sidebar-border px-2 py-1.5 text-xs text-muted-foreground/60">
                      Drop here to settle
                    </p>
                  ) : (
                    <Collapse open={!settledCollapsed}>
                      <ul className="flex flex-col gap-px">
                        {renderRows(visibleSettled)}
                        {sections.settled.length > settledLimit ? (
                          <li className="list-none">
                            <button
                              type="button"
                              onClick={() => setSettledLimit((limit) => limit + RECENTS_PAGE_SIZE)}
                              className={cn(
                                rowClassName,
                                "text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover",
                              )}
                            >
                              Show more
                            </button>
                          </li>
                        ) : null}
                      </ul>
                    </Collapse>
                  )}
                </DropSection>
              ) : null}

              {threads.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
                  {projects.length === 0 ? (
                    <>
                      <span>No projects yet</span>
                      <button
                        type="button"
                        onClick={() => openCommandPalette({ open: "add-project" })}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      >
                        <PlusIcon className="-mx-0.5 size-3" />
                        Add project
                      </button>
                    </>
                  ) : (
                    "No threads yet"
                  )}
                </div>
              ) : null}
            </SidebarGroup>
            <DragOverlay dropAnimation={prefersReducedMotion() ? null : dropAnimation}>
              {overlayThread && overlayThreadKey ? (
                <div
                  className={cn(
                    rowClassName,
                    "pr-1.5",
                    "cursor-grabbing bg-sidebar-row-active text-sidebar-foreground shadow-lg ring-1 ring-sidebar-border",
                  )}
                >
                  <ThreadRowBody
                    thread={overlayThread}
                    threadKey={overlayThreadKey}
                    providerEntries={
                      providerEntriesByEnvironment.get(overlayThread.environmentId) ??
                      EMPTY_PROVIDER_ENTRIES
                    }
                    place={placeByEnvironment.get(overlayThread.environmentId)}
                    isRenaming={false}
                    jumpLabel={null}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </SidebarContent>
      </TooltipProvider>
      <SidebarChromeFooter />
    </>
  );
}
