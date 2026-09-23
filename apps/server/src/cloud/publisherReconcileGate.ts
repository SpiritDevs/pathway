import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/**
 * Backstop for removals a live event missed (a failed call, an out-of-band move). Matches the
 * backend's `PUBLISHER_RECONCILIATION_INTERVAL_MS`, which skips scans within the same window.
 */
export const PUBLISHER_RECONCILE_REPAIR_INTERVAL = Duration.hours(1);

/**
 * Decides when an inventory reconcile can find stale cloud rows. Reconcile only deletes rows whose
 * ids left the inventory, so a tick that merely added ids has nothing for the backend's full scan
 * to find; each such scan reads every published document for the environment.
 */
export const makePublisherReconcileGate = Effect.fn("cloud.publisher_reconcile_gate.make")(
  function* (repairInterval: Duration.Input = PUBLISHER_RECONCILE_REPAIR_INTERVAL) {
    const repairMs = Duration.toMillis(repairInterval);
    const last = yield* Ref.make<{ readonly ids: ReadonlySet<string>; readonly at: number } | null>(
      null,
    );

    /** Runs `reconcile` when due and records the inventory it settled. */
    const run = <E, R>(
      ids: ReadonlyArray<string>,
      reconcile: Effect.Effect<void, E, R>,
    ): Effect.Effect<void, E, R> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const previous = yield* Ref.get(last);
        const current = new Set(ids);
        const due =
          previous === null ||
          now - previous.at >= repairMs ||
          [...previous.ids].some((id) => !current.has(id));
        if (!due) return;
        yield* reconcile;
        yield* Ref.set(last, { ids: current, at: now });
      });

    return { run } as const;
  },
);
