import {
  COMPUTER_SURFACE_METHODS,
  ComputerError,
  EnvironmentAuthorizationError,
  type ComputerSurfaceHandBackInput,
  type ComputerSurfaceInput,
} from "@spiritdevs/contracts";
import { Effect, Stream, Schema } from "effect";
import type { ComputerManager } from "./ComputerManager.ts";
import { saveComputerSurfaceAttachment } from "./computerSurfaceAttachment.ts";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** The caller supplies authorization, evaluated again when queued input dispatches. */
export const makeComputerSurfaceHandlers = (
  manager: ComputerManager,
  clientId: string,
  admit: Effect.Effect<void, ComputerError | EnvironmentAuthorizationError>,
) => {
  const state = () => ({ clientId, state: manager.surfaceControl.snapshot });
  const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isAuthorizationError(cause)
          ? cause
          : new ComputerError({ message: cause instanceof Error ? cause.message : String(cause) }),
      ),
    );
  return {
    [COMPUTER_SURFACE_METHODS.getState]: () => Effect.sync(state),
    [COMPUTER_SURFACE_METHODS.subscribe]: () =>
      manager.surfaceControl.changes.pipe(Stream.map((state) => ({ clientId, state }))),
    [COMPUTER_SURFACE_METHODS.takeControl]: () =>
      attempt(
        Effect.gen(function* () {
          yield* admit;
          const capabilities = manager.surfaceControl.snapshot.capabilities;
          if (!capabilities.input)
            return yield* new ComputerError({
              message: "Computer input is unavailable on this host.",
            });
          yield* manager.surfaceControl.take(clientId);
          return state();
        }),
      ),
    [COMPUTER_SURFACE_METHODS.releaseControl]: () =>
      attempt(manager.surfaceControl.release(clientId).pipe(Effect.map(state))),
    [COMPUTER_SURFACE_METHODS.input]: ({ event }: { event: ComputerSurfaceInput }) =>
      attempt(
        // The manager checks ownership both on receipt and after the queue wait.
        manager.surfaceInput(clientId, event, admit),
      ),
    [COMPUTER_SURFACE_METHODS.handBack]: (input: ComputerSurfaceHandBackInput) =>
      attempt(
        manager.surfaceControl
          .handBack(clientId, (summary) =>
            saveComputerSurfaceAttachment(manager, input).pipe(
              Effect.map((attachment) => ({ attachment, summary })),
            ),
          )
          .pipe(Effect.map((result) => ({ ...result, state: state() }))),
      ),
  };
};
