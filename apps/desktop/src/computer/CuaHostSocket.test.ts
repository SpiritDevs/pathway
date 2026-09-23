// @effect-diagnostics nodeBuiltinImport:off -- The fake connection is a Node event emitter shaped like net.Socket.
import * as NodeEvents from "node:events";
import type * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";

import { type CuaHostSocketIo, clearStaleCuaHostSocket } from "./CuaHostSocket.ts";

const endpoint = "/fixture/cua-host.sock";
const identity = (ino = 1, isSocket = true, uid = process.getuid?.() ?? 0) => ({
  dev: 1,
  ino,
  uid,
  isSocket: () => isSocket,
});

function makeIo(outcome: "connect" | "pending" | NodeJS.ErrnoException = "pending") {
  const createConnection = vi.fn((_path: string) => {
    const socket = new NodeEvents.EventEmitter() as NodeNet.Socket;
    socket.destroy = vi.fn(() => socket);
    if (outcome !== "pending")
      queueMicrotask(() => {
        if (outcome === "connect") socket.emit("connect");
        else socket.emit("error", outcome);
      });
    return socket;
  });
  const io = {
    lstat: vi.fn(async (_path: string) => identity()),
    unlink: vi.fn(async (_path: string) => undefined),
    createConnection,
  } satisfies CuaHostSocketIo;
  return io;
}

const clear = (io: CuaHostSocketIo) =>
  clearStaleCuaHostSocket(endpoint, io).pipe(Effect.provideService(HostProcessPlatform, "linux"));
const errno = (code: string) => Object.assign(new Error(code), { code });
const refused = () => errno("ECONNREFUSED");
const missing = () => errno("ENOENT");

describe("standalone host socket startup", () => {
  it.effect("does not probe or remove a missing endpoint", () =>
    Effect.gen(function* () {
      const io = makeIo();
      io.lstat.mockRejectedValue(missing());
      yield* clear(io);
      assert.strictEqual(io.createConnection.mock.calls.length, 0);
      assert.strictEqual(io.unlink.mock.calls.length, 0);
    }),
  );

  it.effect("preserves ordinary files and symlinks instead of treating them as stale sockets", () =>
    Effect.gen(function* () {
      const io = makeIo();
      io.lstat.mockResolvedValue(identity(1, false));
      const error = yield* Effect.flip(clear(io));
      assert.include(error.message, "non-socket");
      assert.strictEqual(io.createConnection.mock.calls.length, 0);
      assert.strictEqual(io.unlink.mock.calls.length, 0);
    }),
  );

  it.effect("does not delete another user's socket", () =>
    Effect.gen(function* () {
      if (!process.getuid) return;
      const io = makeIo();
      io.lstat.mockResolvedValue(identity(1, true, process.getuid() + 1));
      const error = yield* Effect.flip(clear(io));
      assert.include(error.message, "another user");
      assert.strictEqual(io.createConnection.mock.calls.length, 0);
      assert.strictEqual(io.unlink.mock.calls.length, 0);
    }),
  );

  it.effect("preserves a live listener", () =>
    Effect.gen(function* () {
      const io = makeIo("connect");
      const error = yield* Effect.flip(clear(io));
      assert.include(error.message, "live host");
      assert.strictEqual(io.unlink.mock.calls.length, 0);
    }),
  );

  it.effect("replaces an unchanged socket only after a refused connection", () =>
    Effect.gen(function* () {
      const io = makeIo(refused());
      yield* clear(io);
      assert.strictEqual(io.lstat.mock.calls.length, 2);
      assert.deepStrictEqual(io.unlink.mock.calls, [[endpoint]]);
    }),
  );

  it.effect("preserves the endpoint when the probe is inconclusive", () =>
    Effect.gen(function* () {
      const io = makeIo("pending");
      const fiber = yield* Effect.forkChild(Effect.flip(clear(io)));
      yield* TestClock.adjust(1_000);
      const error = yield* Fiber.join(fiber);
      assert.include(error.message, "Could not determine");
      assert.strictEqual(io.unlink.mock.calls.length, 0);
    }),
  );

  it.effect("does not interpret access errors as a stale socket", () =>
    Effect.gen(function* () {
      const denied = errno("EACCES");
      const io = makeIo(denied);
      const error = yield* Effect.flip(clear(io));
      assert.strictEqual(error._tag, "CuaHostSocketIoError");
      assert.strictEqual(error._tag === "CuaHostSocketIoError" && error.cause, denied);
      assert.strictEqual(io.unlink.mock.calls.length, 0);
    }),
  );

  it.effect("preserves a replacement socket that appeared during the probe", () =>
    Effect.gen(function* () {
      const io = makeIo(refused());
      io.lstat.mockResolvedValueOnce(identity()).mockResolvedValueOnce(identity(2));
      const error = yield* Effect.flip(clear(io));
      assert.include(error.message, "socket changed");
      assert.strictEqual(io.unlink.mock.calls.length, 0);
    }),
  );

  it.effect("does not touch the path if the original listener removed it while being probed", () =>
    Effect.gen(function* () {
      const io = makeIo(missing());
      io.lstat.mockResolvedValueOnce(identity()).mockRejectedValueOnce(missing());
      yield* clear(io);
      assert.strictEqual(io.unlink.mock.calls.length, 0);
    }),
  );

  it.effect("does not remove a socket that reappeared after a missing-endpoint response", () =>
    Effect.gen(function* () {
      const io = makeIo(missing());
      const error = yield* Effect.flip(clear(io));
      assert.include(error.message, "socket changed");
      assert.strictEqual(io.unlink.mock.calls.length, 0);
    }),
  );

  it.effect("does not apply Unix socket cleanup to Windows named pipes", () =>
    Effect.gen(function* () {
      const io = makeIo();
      yield* clearStaleCuaHostSocket("\\\\.\\pipe\\cua-host", io).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      assert.strictEqual(io.lstat.mock.calls.length, 0);
      assert.strictEqual(io.createConnection.mock.calls.length, 0);
      assert.strictEqual(io.unlink.mock.calls.length, 0);
    }),
  );
});
