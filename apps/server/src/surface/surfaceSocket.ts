import { Effect, FiberSet, Option } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { SURFACE_SOCKET_BUDGET, type SurfaceSink } from "./EnvironmentSurfaceStream.ts";

/** Adapts native WebSockets and writer-only sockets to the surface's bounded frame sender. */
export const makeSurfaceSocket = Effect.fn("makeSurfaceSocket")(function* (
  socket: Socket.Socket,
  native: Option.Option<Socket.WebSocket["Service"]>,
) {
  const writer = yield* socket.writer;
  const writes = yield* FiberSet.make<void, Socket.SocketError>();
  const run = yield* FiberSet.runtime(writes)();
  let closed = false;
  let pendingBytes = 0;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );
  const close = (reason = "Surface closed") => {
    if (closed) return;
    closed = true;
    if (Option.isSome(native)) native.value.close(1001, reason);
    else run(writer(new Socket.CloseEvent(1001, reason)));
  };
  const bufferedAmount = () => {
    if (closed) return Infinity;
    if (Option.isSome(native)) return native.value.bufferedAmount;
    // Bun's writer completes when bytes are queued, not when they drain. A pong
    // after the frame proves delivery before we accept another frame.
    return pendingBytes ? Math.max(pendingBytes, SURFACE_SOCKET_BUDGET + 1) : 0;
  };
  const sink: SurfaceSink = {
    send(bytes) {
      if (closed) throw new Error("Surface socket is closed.");
      if (Option.isSome(native)) native.value.send(bytes as Uint8Array<ArrayBuffer>);
      else {
        if (pendingBytes) throw new Error("Surface socket is backpressured.");
        pendingBytes = bytes.byteLength;
        run(writer(bytes).pipe(Effect.andThen(writer("ping"))));
      }
    },
    bufferedAmount,
    close,
  };
  return {
    sink,
    close,
    pong: () => {
      pendingBytes = 0;
    },
    ping: () => {
      if (bufferedAmount() > SURFACE_SOCKET_BUDGET) return;
      if (Option.isSome(native)) native.value.send("ping");
      else {
        pendingBytes = 4;
        run(writer("ping"));
      }
    },
    failure: FiberSet.join(writes),
  };
});
