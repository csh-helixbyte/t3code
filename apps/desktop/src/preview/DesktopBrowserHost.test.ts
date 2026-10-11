// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const decodeCdpResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.Number, error: Schema.optional(Schema.Unknown) }),
  ),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

/** A tab's webContents and debugger, with the debugger's commands left pending until released. */
const makeDebuggee = () => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<(result?: unknown) => void> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string) =>
      new Promise((resolve) => {
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        pending.push((result) => resolve(result ?? { method }));
      }),
  });
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
    isDestroyed: () => false,
  });
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    /** Answers every pending command, with `result` when given. */
    release: (result?: unknown) => pending.splice(0).forEach((resolve) => resolve(result)),
  };
};

/** Reads `count` events from one backend's subscription. */
const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

describe("DesktopBrowserHost", () => {
  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);
      // A restarted backend subscribes after the attach and still hears it.
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
      // Wait until the reader has received the announcement.
      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const [, reply] = yield* Fiber.join(reader);
      // Only the new connection's reply arrives; the old one's id could collide.
      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not type deferred commands from a released connection", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      const started = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const edits: Array<string> = [];
      let first = true;
      Object.assign(debuggee.tab.webContents, {
        mainFrame: {
          frames: [],
          executeJavaScript: async (source: string) => {
            if (source.includes("indexOf(element.contentWindow)")) {
              if (first) {
                first = false;
                started.resolve();
                await resume.promise;
              }
              return -1;
            }
            edits.push(source);
            return true;
          },
        },
      });
      const replies = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.events.pipe(
        Stream.runForEach((line) =>
          Queue.offer(replies, decodeEvent(new TextDecoder().decode(line))),
        ),
        Effect.forkScoped,
      );
      host.attach(key, debuggee.tab);
      expect(yield* Queue.take(replies)).toEqual({ type: "attached", ...key });
      const type = (id: number, text: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({
              id,
              method: "Input.insertText",
              params: { text },
              sessionId: "t3-preview-page",
            }),
          }),
        );
      yield* type(1, "obsolete active input");
      yield* Effect.promise(() => started.promise);
      yield* type(2, "obsolete queued input");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* type(3, "fresh input");
      resume.resolve();
      const reply = yield* Queue.take(replies);
      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(3);
      expect(edits).toHaveLength(1);
      expect(edits[0]).toContain("fresh input");
      expect(host.isDispatchingKeyboard(debuggee.tab.webContents)).toBe(false);
    }).pipe(Effect.scoped),
  );

  // HelixByte fork: Enter that submits a form navigates before its keyup lands.
  it.effect("answers a keyup whose page navigated away instead of waiting on it", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      const keyUpInstalled = Promise.withResolvers<void>();
      const sent: Array<string> = [];
      Object.assign(debuggee.tab.webContents, {
        setIgnoreMenuShortcuts: () => {},
        sendInputEvent: (event: { type: string }) => sent.push(event.type),
        mainFrame: {
          processId: 1,
          frames: [],
          detached: false,
          executeJavaScript: (source: string) => {
            if (source.includes("indexOf(element.contentWindow)")) return Promise.resolve(-1);
            if (source.includes('const type = "keyup"')) {
              keyUpInstalled.resolve();
              // The departing document never answers.
              return new Promise(() => {});
            }
            if (source.includes("?.promise")) return Promise.resolve({ prevented: false });
            return Promise.resolve(undefined);
          },
        },
      });
      const replies = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.events.pipe(
        Stream.runForEach((line) =>
          Queue.offer(replies, decodeEvent(new TextDecoder().decode(line))),
        ),
        Effect.forkScoped,
      );
      host.attach(key, debuggee.tab);
      expect(yield* Queue.take(replies)).toEqual({ type: "attached", ...key });
      const key_ = (id: number, type: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({
              id,
              method: "Input.dispatchKeyEvent",
              params: { type, key: "Enter", text: "\r" },
              sessionId: "t3-preview-page",
            }),
          }),
        );
      yield* key_(1, "keyDown");
      const down = yield* Queue.take(replies);
      expect(decodeCdpResult((down as { message: string }).message)).toMatchObject({ id: 1 });
      yield* key_(2, "keyUp");
      yield* Effect.promise(() => keyUpInstalled.promise);
      (debuggee.tab.webContents as unknown as NodeEvents.EventEmitter).emit(
        "did-start-navigation",
        { isSameDocument: false },
      );
      const up = yield* Queue.take(replies);
      const result = decodeCdpResult((up as { message: string }).message);
      expect(result.id).toBe(2);
      expect(result.error).toBeUndefined();
      expect(sent).toEqual(["keyDown", "char"]);
      // The next keyup after that navigation is answered without touching the page.
      yield* key_(3, "keyUp");
      const after = decodeCdpResult(((yield* Queue.take(replies)) as { message: string }).message);
      expect(after).toMatchObject({ id: 3 });
      expect(after.error).toBeUndefined();
      expect(host.isDispatchingKeyboard(debuggee.tab.webContents)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;
      // Before the server sets a directory, Electron keeps its own handling.
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Browser.setDownloadBehavior",
            params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
          }),
        }),
      );
      debuggee.emit("Browser.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual(["/srv/downloads/guid-1"]);
    }),
  );

  it.effect("tells a download the person clicked from one the agent's input started", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      // Reading the page is not acting on it.
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({ id: 1, method: "DOM.getDocument", params: {} }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(true);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 2,
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 1, y: 1 },
          }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(false);
    }),
  );

  describe("agentActivity", () => {
    const command = (
      host: DesktopBrowserHost.DesktopBrowserHost["Service"],
      id: number,
      method: string,
    ) =>
      host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({ id, method, params: {}, sessionId: "t3-preview-page" }),
        }),
      );
    const settle = Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    /** Records every activity change the host reports. */
    const recordActivity = (host: DesktopBrowserHost.DesktopBrowserHost["Service"]) =>
      Effect.gen(function* () {
        const seen: Array<boolean> = [];
        yield* host.agentActivity.pipe(
          Stream.runForEach(({ active }) => Effect.sync(() => void seen.push(active))),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        return seen;
      });

    it.effect("spans an agent's input from the command to its reply", () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        const seen = yield* recordActivity(host);

        // Reading the page is not acting on it.
        yield* command(host, 1, "DOM.getDocument");
        yield* settle;
        expect(seen).toEqual([]);

        yield* command(host, 2, "Input.dispatchMouseEvent");
        yield* command(host, 3, "Runtime.callFunctionOn");
        yield* settle;
        expect(seen).toEqual([true]);

        debuggee.release();
        yield* settle;
        expect(seen).toEqual([true, false]);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps a navigation in flight until its page loads", () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        const seen = yield* recordActivity(host);

        yield* command(host, 1, "Page.navigate");
        debuggee.release({ frameId: "main", loaderId: "loader-1" });
        yield* settle;
        // An autofocus on the new page can still take focus.
        expect(seen).toEqual([true]);

        debuggee.emit("Page.loadEventFired", { timestamp: 1 });
        yield* settle;
        expect(seen).toEqual([true, false]);
      }).pipe(Effect.scoped),
    );

    it.effect("ends a navigation that never loads with its reply", () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        const seen = yield* recordActivity(host);

        yield* command(host, 1, "Page.navigate");
        debuggee.release({ frameId: "main", loaderId: "loader-1", errorText: "net::ERR_FAILED" });
        yield* settle;
        expect(seen).toEqual([true, false]);
      }).pipe(Effect.scoped),
    );

    it.effect("ends an action when the server releases the tab mid-command", () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        host.attach(key, makeDebuggee().tab);
        const seen = yield* recordActivity(host);

        yield* command(host, 1, "Input.insertText");
        yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
        yield* settle;
        expect(seen).toEqual([true, false]);
      }).pipe(Effect.scoped),
    );
  });
});
