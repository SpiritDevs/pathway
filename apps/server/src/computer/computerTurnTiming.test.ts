import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { ComputerTurnTimings, type ComputerTurnTimingRow } from "./computerTurnTiming.ts";

function collectingTimings() {
  const rows: ComputerTurnTimingRow[] = [];
  const timings = new ComputerTurnTimings((row) =>
    Effect.sync(() => {
      rows.push(row);
    }),
  );
  return { rows, timings };
}

describe("computer turn timings", () => {
  it.effect("measures model delay and observation-to-write without another native call", () =>
    Effect.gen(function* () {
      const { rows, timings } = collectingTimings();
      yield* timings.start("thread", "turn");
      yield* TestClock.adjust("100 millis");
      const observed = yield* timings.begin("thread", "turn", "observation");
      yield* TestClock.adjust("50 millis");
      yield* observed(true);
      yield* TestClock.adjust("150 millis");
      const wrote = yield* timings.begin("thread", "turn", "write");
      yield* TestClock.adjust("20 millis");
      yield* wrote(true);
      expect(rows[1]).toMatchObject({
        origin: "provider-turn-start",
        time_to_first_observation_ms: 150,
        time_to_first_write_ms: 300,
        observe_to_write_start_ms: 150,
        observe_to_write_end_ms: 170,
      });
    }),
  );

  it.effect("does not record refusals or late completions after a turn ends", () =>
    Effect.gen(function* () {
      const { rows, timings } = collectingTimings();
      yield* TestClock.adjust("10 millis");
      yield* (yield* timings.begin("thread", "old", "write"))(false);
      const old = yield* timings.begin("thread", "old", "observation");
      yield* timings.start("thread", "new");
      timings.end("thread", "old");
      yield* old(true);
      yield* (yield* timings.begin("thread", "new", "write"))(true);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ turnId: "new" });
    }),
  );

  it.effect("labels missing provider start honestly and isolates overlapping turns", () =>
    Effect.gen(function* () {
      const { rows, timings } = collectingTimings();
      yield* (yield* timings.begin("t", "a", "observation"))(true);
      yield* TestClock.adjust("10 millis");
      yield* (yield* timings.begin("t", "b", "write"))(true);
      expect(rows[1]).toMatchObject({ origin: "first-computer-call", time_to_first_write_ms: 0 });
      expect(rows[1]).not.toHaveProperty("observe_to_write_start_ms");
    }),
  );
});
