import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { findRunningServer } from "./DesktopSharedHomeGuard.ts";

const listeningPort = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

const withStateDir = Effect.fn(function* (runtime?: { pid: number; port: number }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "helixbyte-guard-" });
  if (runtime) {
    yield* fs.writeFileString(
      path.join(stateDir, "server-runtime.json"),
      JSON.stringify({ version: 1, ...runtime, origin: "http://127.0.0.1", startedAt: "now" }),
    );
  }
  return stateDir;
});

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("findRunningServer", (it) => {
  it.effect("reports a live server that still holds its port", () =>
    Effect.gen(function* () {
      const port = yield* listeningPort;
      const stateDir = yield* withStateDir({ pid: process.ppid, port });
      assert.deepStrictEqual(
        yield* findRunningServer(stateDir),
        Option.some({ pid: process.ppid, port }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a missing file, a dead process, and a port nobody answers", () =>
    Effect.gen(function* () {
      const port = yield* listeningPort;
      for (const stateDir of [
        yield* withStateDir(),
        yield* withStateDir({ pid: 99_999_999, port }),
        yield* withStateDir({ pid: process.pid, port }),
      ]) {
        assert.isTrue(Option.isNone(yield* findRunningServer(stateDir)));
      }
      const net = yield* NetService.NetService;
      const freePort = yield* net.reserveLoopbackPort();
      const leftover = yield* withStateDir({ pid: process.ppid, port: freePort });
      assert.isTrue(Option.isNone(yield* findRunningServer(leftover)));
    }).pipe(Effect.scoped),
  );
});
