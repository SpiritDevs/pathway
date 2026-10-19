import type { ApplicationActivity } from "../platform/capabilities.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const RELAY_ENVIRONMENT_DISCOVERY_REFRESH_INTERVAL = "30 seconds";

/**
 * Keeps relay availability current for the lifetime of the client runtime,
 * while suspending periodic work whenever the platform is backgrounded.
 */
export const run = Effect.fn("RelayEnvironmentDiscoveryLifecycle.run")(function* (input: {
  readonly activity: ApplicationActivity["Service"];
  readonly refresh: Effect.Effect<void>;
}) {
  const refreshWhileActive = input.activity.status.pipe(
    Effect.flatMap((status) => (status === "active" ? input.refresh : Effect.void)),
  );

  yield* refreshWhileActive;
  yield* Effect.all(
    [
      Effect.forever(
        Effect.sleep(RELAY_ENVIRONMENT_DISCOVERY_REFRESH_INTERVAL).pipe(
          Effect.andThen(refreshWhileActive),
        ),
      ),
      input.activity.changes.pipe(
        Stream.changes,
        Stream.runForEach((status) => (status === "active" ? input.refresh : Effect.void)),
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );
});
