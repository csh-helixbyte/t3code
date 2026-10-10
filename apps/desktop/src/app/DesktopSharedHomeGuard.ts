import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// HelixByte fork: stable and nightly share one T3 home (settings, secrets and
// environment identity) and keep separate thread databases, so only one of them
// may run a server against it at a time.

const RunningServer = Schema.Struct({ pid: Schema.Int, port: Schema.Int });
export type RunningServer = typeof RunningServer.Type;
const decodeRunningServer = Schema.decodeUnknownOption(Schema.fromJsonString(RunningServer));

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The server another process is running from `stateDir`, read from the
 * `server-runtime.json` every server writes on start and clears on exit.
 */
export const findRunningServer = Effect.fn("desktop.sharedHomeGuard.findRunningServer")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* NetService.NetService;
  const raw = yield* fs
    .readFileString(path.join(stateDir, "server-runtime.json"))
    .pipe(Effect.option);
  const server = Option.flatMap(raw, decodeRunningServer);
  if (Option.isNone(server)) return server;
  if (server.value.pid === process.pid || !isProcessAlive(server.value.pid)) {
    return Option.none<RunningServer>();
  }
  // A crashed server leaves the file behind and its pid can be reused, so the
  // recorded port must still be answering too.
  return (yield* net.hasListenerOnHost(server.value.port, "127.0.0.1"))
    ? server
    : Option.none<RunningServer>();
});
