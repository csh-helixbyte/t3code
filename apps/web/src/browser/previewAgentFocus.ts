import type { DesktopPreviewAgentActivityEvent } from "@t3tools/contracts";

interface AgentAction {
  readonly tabId: string;
  readonly order: number;
  previous: Element | null;
}

// The agent can act on several tabs and threads at once.
const inFlightActions = new Map<string, AgentAction>();
const lastFinishedActions = new Map<string, AgentAction>();
let nextActionOrder = 0;

const focusedPreviewTab = (element: Element | null): string | null =>
  element?.localName === "webview" ? element.getAttribute("data-preview-tab") : null;

const restoreHostFocus = ({ tabId, previous }: AgentAction): void => {
  const current = document.activeElement;
  if (
    !(current instanceof HTMLElement) ||
    current === previous ||
    focusedPreviewTab(current) !== tabId
  ) {
    return;
  }
  if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) {
    previous.focus({ preventScroll: true });
  }
  // The previous element may no longer take focus, like a composer that was
  // disabled during the action. Never leave focus in the page.
  if (document.activeElement === current) current.blur();
};

/**
 * Hands keyboard focus back to the host page after the agent acts on a desktop
 * preview tab. Fed by the desktop's agent activity events.
 *
 * A click, typed text, a key press, a page script or a page load can each focus
 * the guest page, which moves keyboard focus into its <webview>, and nothing
 * gives it back. The user's next keystrokes then go into the page, even when its
 * tab is hidden or belongs to another thread. Only this document knows what had
 * focus before the action, so the restore happens here and not in the desktop
 * main process. Focus is restored only when it ended up in this tab's page, so
 * an action that leaves focus alone changes nothing.
 */
export function handlePreviewAgentActivity({ tabId, active }: DesktopPreviewAgentActivityEvent) {
  if (active) {
    if (!inFlightActions.has(tabId)) {
      inFlightActions.set(tabId, {
        tabId,
        order: nextActionOrder++,
        previous: document.activeElement,
      });
    }
    return;
  }
  const entry = inFlightActions.get(tabId);
  if (!entry) return;
  inFlightActions.delete(tabId);
  // An action that started while this one held focus in its page saw that page
  // as what had focus. Hand it this action's target instead. An action that
  // never finishes never gets here, so it cannot override where the user goes later.
  for (const other of inFlightActions.values()) {
    if (other.order > entry.order && focusedPreviewTab(other.previous) === tabId) {
      other.previous = entry.previous;
    }
  }
  restoreHostFocus(entry);
  // The page's focus reaches this document separately from the end of the
  // action, and can land just after it. A later action on the tab owns it then.
  lastFinishedActions.set(tabId, entry);
  window.requestAnimationFrame(() => {
    if (lastFinishedActions.get(tabId) !== entry) return;
    lastFinishedActions.delete(tabId);
    if (!inFlightActions.has(tabId)) restoreHostFocus(entry);
  });
}
