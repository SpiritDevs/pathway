import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { makePublisherReconcileGate } from "./publisherReconcileGate.ts";

describe("publisher reconcile gate", () => {
  it.effect("reconciles on start, on removals, and on the repair interval only", () =>
    Effect.gen(function* () {
      const gate = yield* makePublisherReconcileGate("1 hour");
      const calls = yield* Ref.make(0);
      const run = (ids: ReadonlyArray<string>) =>
        gate.run(
          ids,
          Ref.update(calls, (count) => count + 1),
        );

      yield* run(["a", "b"]);
      yield* run(["a", "b"]);
      yield* run(["a", "b", "c"]);
      assert.strictEqual(yield* Ref.get(calls), 1);

      yield* run(["a", "c"]);
      assert.strictEqual(yield* Ref.get(calls), 2);

      yield* TestClock.adjust("1 hour");
      yield* run(["a", "c"]);
      assert.strictEqual(yield* Ref.get(calls), 3);
    }),
  );

  it.effect("retries a reconcile that failed", () =>
    Effect.gen(function* () {
      const gate = yield* makePublisherReconcileGate("1 hour");
      yield* Effect.exit(gate.run(["a"], Effect.fail("offline")));
      const calls = yield* Ref.make(0);
      yield* gate.run(
        ["a"],
        Ref.update(calls, (count) => count + 1),
      );
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );
});
