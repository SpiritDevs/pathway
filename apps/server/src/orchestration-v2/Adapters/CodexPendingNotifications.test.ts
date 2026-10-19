import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeCodexPendingNotifications } from "./CodexPendingNotifications.ts";

describe("Codex early notifications", () => {
  it.effect("drains each child's events once and in wire order", () =>
    Effect.gen(function* () {
      const buffer = makeCodexPendingNotifications();
      const observed: string[] = [];
      for (const [key, value] of [
        ["a", "first"],
        ["b", "sibling"],
        ["a", "last"],
      ] as const) {
        yield* buffer.enqueue(
          key,
          value,
          Effect.sync(() => {
            observed.push(value);
          }),
        );
      }
      yield* buffer.drain("a");
      yield* buffer.drain("a");
      assert.deepEqual(observed, ["first", "last"]);
      yield* buffer.drain("b");
      assert.deepEqual(observed, ["first", "last", "sibling"]);
    }),
  );

  it.effect("bounds event count and bytes while retaining the newest complete events", () =>
    Effect.gen(function* () {
      const buffer = makeCodexPendingNotifications({ maxEvents: 2, maxBytes: 10 });
      const observed: string[] = [];
      const put = (value: string) =>
        buffer.enqueue(
          "a",
          value,
          Effect.sync(() => {
            observed.push(value);
          }),
        );
      yield* put("a");
      yield* put("b");
      yield* put("c");
      yield* put("dddd");
      yield* put("too large to retain");
      yield* buffer.drain("a");
      assert.deepEqual(observed, ["c", "dddd"]);
      yield* put("eeeee");
      yield* buffer.drain("a");
      assert.deepEqual(observed, ["c", "dddd", "eeeee"]);
    }),
  );
});
