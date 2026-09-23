/**
 * The task a computer call is attributed to: local IPC metadata, never
 * additional model context. Detached continuations lose it once the call ends.
 *
 * @module computer/computerTaskContext
 */
import type { CuaComputerTask } from "@spiritdevs/shared/cuaDriverProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

interface ComputerTaskScope {
  readonly task: CuaComputerTask;
  active: boolean;
}

class ComputerTaskContext extends Context.Reference<ComputerTaskScope | undefined>(
  "@spiritdevs/pathway/computer/ComputerTaskContext",
  { defaultValue: () => undefined },
) {}

export const currentComputerTask: Effect.Effect<CuaComputerTask | undefined> = Effect.map(
  Effect.service(ComputerTaskContext),
  (scope) => (scope?.active ? scope.task : undefined),
);

export const withComputerTask = <A, E, R>(
  task: CuaComputerTask,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const scope: ComputerTaskScope = { task, active: true };
    return effect.pipe(
      Effect.provideService(ComputerTaskContext, scope),
      Effect.ensuring(
        Effect.sync(() => {
          scope.active = false;
        }),
      ),
    );
  });
