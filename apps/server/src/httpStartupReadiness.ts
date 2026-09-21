import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HTTP_SHELL_READINESS_PATH } from "@spiritdevs/shared/httpReadiness";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";

/** Applied to data/control routes only; the public static shell can load during recovery. */
export const commandReadinessLayer = HttpRouter.middleware(
  Effect.map(
    ServerRuntimeStartup,
    (startup) => (httpEffect) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
  ),
).layer;

/** This announces route availability, never command readiness or authentication. */
export const rendererShellReadinessRouteLayer = HttpRouter.add(
  "GET",
  HTTP_SHELL_READINESS_PATH,
  Effect.succeed(HttpServerResponse.empty({ status: 204 })),
);
