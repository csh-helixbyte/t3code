import { useAtomValue } from "@effect/atom-react";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MoreHorizontalIcon, PlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
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
  partitionClaudeSidebar,
  resolveClaudeSidebarDot,
  type ClaudeSidebarDot,
} from "./ClaudeSidebar.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";

// HelixByte fork: a Claude desktop style sidebar. One line per thread with a
// trailing status dot, sectioned into Pinned, the user's own groups (kept in
// localStorage, see threadGroupsStore) and Recents.

const RECENTS_PAGE_SIZE = 40;

function threadKeyOf(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
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
    "text-muted-foreground bg-current shadow-[0_0_6px_currentColor] motion-safe:animate-status-pulse",
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
            className={cn("size-2 shrink-0 rounded-full", dotClassName[dot])}
          />
        }
      />
      <TooltipPopup side="top">{dotLabel[dot]}</TooltipPopup>
    </Tooltip>
  );
}

const rowClassName =
  "group/claude-row flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

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

const ClaudeThreadRow = memo(function ClaudeThreadRow(props: {
  thread: SidebarThreadSummary;
  threadKey: string;
  isActive: boolean;
  isRenaming: boolean;
  jumpLabel: string | null;
  onOpen: (thread: SidebarThreadSummary) => void;
  onContextMenu: (threadKey: string, position: { x: number; y: number }) => void;
  onRenameCommit: (thread: SidebarThreadSummary, title: string) => void;
  onRenameCancel: () => void;
}) {
  const { thread, threadKey, onOpen, onContextMenu } = props;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const dot = resolveClaudeSidebarDot({ ...thread, lastVisitedAt });
  const openMenuAt = useCallback(
    (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      onContextMenu(threadKey, { x: rect.right, y: rect.bottom });
    },
    [onContextMenu, threadKey],
  );
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-current={props.isActive ? "page" : undefined}
        data-testid="claude-sidebar-thread-row"
        className={cn(
          rowClassName,
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover",
        )}
        onClick={() => {
          if (!props.isRenaming) onOpen(thread);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(threadKey, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (props.isRenaming) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(thread);
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            openMenuAt(event.currentTarget);
          }
        }}
      >
        {props.isRenaming ? (
          <InlineNameInput
            initial={thread.title}
            ariaLabel="Thread title"
            onCommit={(title) => props.onRenameCommit(thread, title)}
            onCancel={props.onRenameCancel}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        )}
        {props.jumpLabel ? (
          <span className="shrink-0 rounded-sm bg-sidebar-row-hover px-1 text-2xs text-muted-foreground">
            {props.jumpLabel}
          </span>
        ) : dot ? (
          <StatusDot dot={dot} />
        ) : null}
      </div>
    </li>
  );
});

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
      className="group/claude-section mt-3 flex h-7 items-center gap-1 px-2.5 text-xs text-sidebar-muted-foreground/70"
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
          className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-sidebar-foreground"
        >
          {props.label}
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
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm opacity-0 group-hover/claude-section:opacity-100 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </button>
      ) : null}
      {props.onAdd ? (
        <button
          type="button"
          aria-label={props.addLabel}
          onClick={props.onAdd}
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
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
  const { pinThread, confirmAndUnpinThread, archiveThread, deleteThread, markThreadUnread } =
    useThreadActions();
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

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
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

  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;

  const sections = useMemo(
    () => partitionClaudeSidebar({ threads, threadKey: threadKeyOf, groups, groupIdByThreadKey }),
    [groupIdByThreadKey, groups, threads],
  );
  const visibleRecents = sections.recents.slice(0, recentsLimit);
  // Keyboard jump and traversal follow what is on screen, top to bottom.
  const orderedThreads = useMemo(
    () => [
      ...(pinnedCollapsed ? [] : sections.pinned),
      ...sections.groups.flatMap(({ group, threads: groupThreads }) =>
        group.collapsed ? [] : groupThreads,
      ),
      ...(recentsCollapsed ? [] : sections.recents.slice(0, recentsLimit)),
    ],
    [pinnedCollapsed, recentsCollapsed, recentsLimit, sections],
  );
  const orderedThreadKeys = useMemo(() => orderedThreads.map(threadKeyOf), [orderedThreads]);
  const threadByKey = useMemo(
    () => new Map(threads.map((thread) => [threadKeyOf(thread), thread] as const)),
    [threads],
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
        const threadRef: ScopedThreadRef = scopeThreadRef(thread.environmentId, thread.id);
        const supportsPinning =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning === true;
        const isPinned = thread.pinnedAt != null;
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
      startNewGroup,
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

  const renderRows = (rows: readonly SidebarThreadSummary[]) =>
    rows.map((thread) => {
      const threadKey = threadKeyOf(thread);
      return (
        <ClaudeThreadRow
          key={threadKey}
          thread={thread}
          threadKey={threadKey}
          isActive={routeThreadKey === threadKey}
          isRenaming={renamingThreadKey === threadKey}
          jumpLabel={showThreadJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
          onOpen={openThread}
          onContextMenu={handleThreadContextMenu}
          onRenameCommit={commitThreadRename}
          onRenameCancel={cancelThreadRename}
        />
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
          <SidebarGroup className="flex-1" role="presentation">
            <div className="flex flex-col gap-px">
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
            </div>

            {sections.pinned.length > 0 ? (
              <section aria-label="Pinned">
                <SectionHeader label="Pinned" collapsed={pinnedCollapsed} onToggle={togglePinned} />
                {pinnedCollapsed ? null : (
                  <ul className="flex flex-col gap-px">{renderRows(sections.pinned)}</ul>
                )}
              </section>
            ) : null}

            {sections.groups.map(({ group, threads: groupThreads }) => (
              <section key={group.id} aria-label={group.name}>
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
                {group.collapsed ? null : groupThreads.length > 0 ? (
                  <ul className="flex flex-col gap-px">{renderRows(groupThreads)}</ul>
                ) : (
                  <p className="px-2.5 py-1 text-xs text-muted-foreground/50">
                    Right-click a thread to move it here
                  </p>
                )}
              </section>
            ))}

            <section aria-label="Recents">
              <SectionHeader
                label="Recents"
                collapsed={recentsCollapsed}
                onToggle={toggleRecents}
                onMenu={handleRecentsMenu}
                onAdd={projects.length > 0 ? () => handleNewThread() : undefined}
                addLabel="New thread from Recents"
              />
              {recentsCollapsed ? null : (
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
              )}
            </section>

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
        </SidebarContent>
      </TooltipProvider>
      <SidebarChromeFooter />
    </>
  );
}
