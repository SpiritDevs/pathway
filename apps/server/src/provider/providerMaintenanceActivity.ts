import type { ProviderDriverKind } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { ProviderInstance } from "./ProviderDriver.ts";

// Sessions and one-shot jobs share read permits. An update needs every permit,
// so it cannot replace a CLI while any instance of that driver is using it.
const PERMITS = Number.MAX_SAFE_INTEGER;

export interface ProviderMaintenanceActivityShape {
  readonly acquireUse: (driver: ProviderDriverKind) => Effect.Effect<void, never, Scope.Scope>;
  readonly withUse: <A, E, R>(
    driver: ProviderDriverKind,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly whenIdle: <A, E, R>(
    driver: ProviderDriverKind,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class ProviderMaintenanceActivity extends Context.Service<
  ProviderMaintenanceActivity,
  ProviderMaintenanceActivityShape
>()("@spiritdevs/pathway/provider/providerMaintenanceActivity") {}

export const make = Effect.sync(() => {
  const locks = new Map<ProviderDriverKind, Semaphore.Semaphore>();
  const lockFor = (driver: ProviderDriverKind) => {
    let lock = locks.get(driver);
    if (!lock) {
      lock = Semaphore.makeUnsafe(PERMITS);
      locks.set(driver, lock);
    }
    return lock;
  };
  return ProviderMaintenanceActivity.of({
    acquireUse: (driver) => {
      const lock = lockFor(driver);
      return Effect.acquireRelease(lock.take(1), () => lock.release(1)).pipe(Effect.asVoid);
    },
    withUse: (driver, effect) => lockFor(driver).withPermits(1)(effect),
    whenIdle: (driver, effect) => lockFor(driver).withPermits(PERMITS)(effect),
  });
});

export const layer = Layer.effect(ProviderMaintenanceActivity, make);

export function trackProviderActivity(
  instance: ProviderInstance,
  activity: ProviderMaintenanceActivityShape,
): ProviderInstance {
  const text = instance.textGeneration;
  const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    activity.withUse(instance.driverKind, effect);
  return {
    ...instance,
    orchestrationAdapter: {
      ...instance.orchestrationAdapter,
      openSession: (input) =>
        activity
          .acquireUse(instance.driverKind)
          .pipe(Effect.andThen(instance.orchestrationAdapter.openSession(input))),
    },
    textGeneration: {
      generateCommitMessage: (input) => use(text.generateCommitMessage(input)),
      generatePrContent: (input) => use(text.generatePrContent(input)),
      generateBranchName: (input) => use(text.generateBranchName(input)),
      generateThreadTitle: (input) => use(text.generateThreadTitle(input)),
      investigate: (input) => use(text.investigate(input)),
    },
  };
}
