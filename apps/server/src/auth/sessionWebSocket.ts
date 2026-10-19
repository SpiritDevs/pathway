import type { AuthSessionId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./http.ts";
import { SessionStore } from "./SessionStore.ts";

/** Runs a socket only while its authenticated session remains active. */
export const withSessionWebSocket = <E, R>(
  sessionId: AuthSessionId,
  use: (socket: Socket.Socket) => Effect.Effect<void, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* SessionStore;
      // Subscribe before checking persisted state, so a removal during admission is retained.
      const removed = yield* sessions.streamChanges.pipe(
        Stream.filter(
          (change) => change.type === "clientRemoved" && change.sessionId === sessionId,
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      const active = yield* sessions
        .listActive()
        .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
      if (!active.some((session) => session.sessionId === sessionId)) {
        return yield* failEnvironmentAuthInvalid("invalid_credential");
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* request.upgrade;
      const writer = yield* socket.writer;
      yield* use(socket).pipe(
        Effect.interruptible,
        Effect.raceFirst(
          Fiber.join(removed).pipe(
            Effect.andThen(writer(new Socket.CloseEvent(1008, "Session revoked"))),
          ),
        ),
      );
    }),
  );
