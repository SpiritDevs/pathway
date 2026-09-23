/**
 * Whether the running fiber is a model-requested desktop observation. The
 * manager wraps a model's perception read in `withModelDesktopObservation`,
 * and code beneath it asks `isModelDesktopObservationActive` to tell that
 * read apart from the pane's own captures.
 *
 * Detached continuations lose observation authority when their operation ends.
 *
 * @module computer/modelDesktopObservation
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

interface ModelDesktopObservationScope {
  active: boolean;
}

class ModelDesktopObservation extends Context.Reference<ModelDesktopObservationScope | undefined>(
  "@spiritdevs/pathway/computer/ModelDesktopObservation",
  { defaultValue: () => undefined },
) {}

/** True only inside a still-running `withModelDesktopObservation`. */
export const isModelDesktopObservationActive: Effect.Effect<boolean> = Effect.map(
  Effect.service(ModelDesktopObservation),
  (scope) => scope?.active === true,
);

/** Runs `observe` as a model desktop observation; authority ends with it, however it ends. */
export const withModelDesktopObservation = <A, E, R>(
  observe: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const scope: ModelDesktopObservationScope = { active: true };
    return observe.pipe(
      Effect.provideService(ModelDesktopObservation, scope),
      Effect.ensuring(
        Effect.sync(() => {
          scope.active = false;
        }),
      ),
    );
  });
