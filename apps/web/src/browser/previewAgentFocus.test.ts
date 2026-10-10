// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { handlePreviewAgentActivity } from "./previewAgentFocus";

const TAB = "runtime-tab";

const mount = (tagName: string, previewTab?: string) => {
  const element = document.createElement(tagName);
  element.tabIndex = -1;
  if (previewTab) element.setAttribute("data-preview-tab", previewTab);
  document.body.append(element);
  return element;
};

const start = (tabId: string) => handlePreviewAgentActivity({ tabId, active: true });
const finish = (tabId: string) => handlePreviewAgentActivity({ tabId, active: false });
const nextFrame = () =>
  new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

afterEach(() => {
  // Leaves no action in flight for the next test.
  for (const tabId of [TAB, "other-tab", "stuck-tab"]) finish(tabId);
  document.body.replaceChildren();
});

describe("handlePreviewAgentActivity", () => {
  it("gives focus back to the composer after an agent action focuses the page", () => {
    const composer = mount("textarea");
    const webview = mount("webview", TAB);
    composer.focus();

    start(TAB);
    webview.focus();
    finish(TAB);

    expect(document.activeElement).toBe(composer);
  });

  it("gives focus back when the page's focus arrives just after the action ends", async () => {
    const composer = mount("textarea");
    const webview = mount("webview", TAB);
    composer.focus();

    start(TAB);
    finish(TAB);
    webview.focus();
    await nextFrame();

    expect(document.activeElement).toBe(composer);
  });

  it("leaves focus alone when the action did not move it into the page", () => {
    const composer = mount("textarea");
    const other = mount("input");
    composer.focus();

    start(TAB);
    other.focus();
    finish(TAB);

    expect(document.activeElement).toBe(other);
  });

  it("keeps focus in the page when the user was already typing there", () => {
    const webview = mount("webview", TAB);
    webview.focus();

    start(TAB);
    finish(TAB);

    expect(document.activeElement).toBe(webview);
  });

  it("gives focus back once overlapping actions in two tabs finish", () => {
    const composer = mount("textarea");
    const first = mount("webview", TAB);
    const second = mount("webview", "other-tab");
    composer.focus();

    start(TAB);
    first.focus();
    // Starts while the first action holds focus in its page, and finishes last.
    start("other-tab");
    second.focus();
    finish(TAB);
    finish("other-tab");

    expect(document.activeElement).toBe(composer);
  });

  it("keeps the user's page when overlapping actions finish in reverse order", () => {
    const first = mount("webview", TAB);
    const second = mount("webview", "other-tab");
    second.focus();

    start(TAB);
    first.focus();
    // Starts while the first action holds focus in its page, and finishes first.
    start("other-tab");
    second.focus();
    finish("other-tab");
    finish(TAB);

    expect(document.activeElement).toBe(second);
  });

  it("ignores an action that never finishes", () => {
    const composer = mount("textarea");
    const stuck = mount("webview", "stuck-tab");
    const webview = mount("webview", TAB);
    const other = mount("webview", "other-tab");
    composer.focus();

    start("stuck-tab");
    start(TAB);
    webview.focus();
    finish(TAB);
    expect(document.activeElement).toBe(composer);

    // The user opens the stuck tab's page themselves.
    stuck.focus();
    start("other-tab");
    other.focus();
    finish("other-tab");
    expect(document.activeElement).toBe(stuck);
  });

  it("leaves no focus in the page when the composer can no longer take focus", () => {
    const composer = mount("div");
    const webview = mount("webview", TAB);
    composer.focus();

    start(TAB);
    webview.focus();
    // Like the editor going read-only for an approval request.
    composer.removeAttribute("tabindex");
    finish(TAB);

    expect(document.activeElement).toBe(document.body);
  });
});
