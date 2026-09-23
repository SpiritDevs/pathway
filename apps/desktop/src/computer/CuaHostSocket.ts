// @effect-diagnostics nodeBuiltinImport:off -- Stale-socket recovery needs lstat identities and a raw Unix-socket probe.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";

export class CuaHostSocketError extends Schema.TaggedErrorClass<CuaHostSocketError>()(
  "CuaHostSocketError",
  {
    reason: Schema.Literals(["live-listener", "inconclusive", "changed", "non-socket", "foreign"]),
    message: Schema.String,
  },
) {}

/** An unexpected filesystem or connection error, kept as its original Node error. */
export class CuaHostSocketIoError extends Schema.TaggedErrorClass<CuaHostSocketIoError>()(
  "CuaHostSocketIoError",
  { endpoint: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not inspect the Cua host socket ${this.endpoint}.`;
  }
}

interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  isSocket(): boolean;
}

/** The filesystem and socket calls the stale-socket check makes; tests replace them. */
export interface CuaHostSocketIo {
  readonly lstat: (path: string) => Promise<SocketIdentity>;
  readonly unlink: (path: string) => Promise<void>;
  readonly createConnection: (path: string) => NodeNet.Socket;
}

const nodeIo: CuaHostSocketIo = {
  lstat: (path) => NodeFS.promises.lstat(path),
  unlink: (path) => NodeFS.promises.unlink(path),
  createConnection: (path) => NodeNet.createConnection(path),
};

const PROBE_TIMEOUT_MS = 1_000;

/** Replace only an owned socket whose former listener is proven absent. */
export const clearStaleCuaHostSocket = Effect.fn("clearStaleCuaHostSocket")(function* (
  endpoint: string,
  io: CuaHostSocketIo = nodeIo,
) {
  if ((yield* HostProcessPlatform) === "win32") return;
  const candidate = yield* socketIdentity(endpoint, io);
  if (!candidate) return;

  const probe = yield* Effect.callback<
    "refused" | "missing",
    CuaHostSocketError | CuaHostSocketIoError
  >((resume) => {
    const socket = io.createConnection(endpoint);
    socket.once("connect", () =>
      resume(
        Effect.fail(
          new CuaHostSocketError({
            reason: "live-listener",
            message: `A live host already listens on ${endpoint}.`,
          }),
        ),
      ),
    );
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resume(Effect.succeed("refused"));
      else if (error.code === "ENOENT") resume(Effect.succeed("missing"));
      else resume(Effect.fail(new CuaHostSocketIoError({ endpoint, cause: error })));
    });
    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new CuaHostSocketError({
            reason: "inconclusive",
            message: `Could not determine whether a live host listens on ${endpoint}.`,
          }),
        ),
    }),
  );

  // A different host may have replaced the path while the probe was in
  // flight. Never unlink that host's listener based on the earlier result.
  const current = yield* socketIdentity(endpoint, io);
  if (!current) return;
  if (probe === "missing" || candidate.dev !== current.dev || candidate.ino !== current.ino)
    return yield* new CuaHostSocketError({
      reason: "changed",
      message: `The host socket changed while checking ${endpoint}; retry setup.`,
    });
  yield* Effect.tryPromise({
    try: () => io.unlink(endpoint),
    catch: (cause) => new CuaHostSocketIoError({ endpoint, cause }),
  });
});

const socketIdentity = Effect.fn("socketIdentity")(function* (
  endpoint: string,
  io: CuaHostSocketIo,
) {
  const identity = yield* Effect.tryPromise({
    try: () =>
      io.lstat(endpoint).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
    catch: (cause) => new CuaHostSocketIoError({ endpoint, cause }),
  });
  if (!identity) return undefined;
  if (!identity.isSocket())
    return yield* new CuaHostSocketError({
      reason: "non-socket",
      message: `Refusing to replace a non-socket host path: ${endpoint}.`,
    });
  if (process.getuid && identity.uid !== process.getuid())
    return yield* new CuaHostSocketError({
      reason: "foreign",
      message: `Refusing to replace a host socket owned by another user: ${endpoint}.`,
    });
  return identity;
});
