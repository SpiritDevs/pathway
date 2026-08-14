/**
 * Cloud sync capability flag.
 *
 * Cloud sync lands dark: the reference defaults to disabled, so a build that has the engine
 * compiled in still performs no network work and changes no existing behavior. A platform opts in
 * by providing this reference; the engine's `run` loop is a no-op until it does.
 *
 * @module sync/capability
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface CloudSyncCapabilityState {
  readonly enabled: boolean;
}

export class CloudSyncCapability extends Context.Reference<CloudSyncCapabilityState>(
  "@t3tools/client-runtime/sync/capability/CloudSyncCapability",
  { defaultValue: () => ({ enabled: false }) },
) {}

export const cloudSyncEnabled: Effect.Effect<boolean> = CloudSyncCapability.pipe(
  Effect.map((capability) => capability.enabled),
);

/** Runs `effect` only while the capability is on; otherwise answers `whenDisabled`. */
export function whenCloudSyncEnabled<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  whenDisabled: A,
): Effect.Effect<A, E, R> {
  return Effect.flatMap(cloudSyncEnabled, (enabled) =>
    enabled ? effect : Effect.succeed(whenDisabled),
  );
}
