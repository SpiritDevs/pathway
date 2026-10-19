import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Pull from "effect/Pull";
import * as Stream from "effect/Stream";

import { makeSequencedLiveTail } from "./sequencedLiveTail.ts";

interface TestEvent {
  readonly sequence: number;
  readonly threadId: string;
}

// An in-memory durable log standing in for the event store.
const makeLog = (capacity: number) => {
  const committed: Array<TestEvent> = [];
  const replays: Array<readonly [number, number]> = [];
  const tail = makeSequencedLiveTail<TestEvent>(capacity);
  const commit = (threadId: string) => {
    const event = { sequence: committed.length + 1, threadId };
    committed.push(event);
    return event;
  };
  const subscribe = (afterSequence: number, threadId?: string) =>
    Stream.toPull(
      tail.stream({
        afterSequence,
        ...(threadId === undefined
          ? {}
          : { accepts: (event: TestEvent) => event.threadId === threadId }),
        highWater: Effect.sync(() => committed.length),
        replay: (after, through) =>
          Stream.suspend(() => {
            replays.push([after, through]);
            return Stream.fromIterable(
              committed.filter(
                (event) =>
                  event.sequence > after &&
                  event.sequence <= through &&
                  (threadId === undefined || event.threadId === threadId),
              ),
            );
          }),
      }),
    );
  return { committed, replays, tail, commit, subscribe };
};

const pullThrough = Effect.fn("pullThrough")(function* (
  pull: Pull.Pull<ReadonlyArray<TestEvent>>,
  sequence: number,
) {
  const received: Array<number> = [];
  while ((received.at(-1) ?? 0) < sequence) {
    const chunk = yield* pull;
    received.push(...chunk.map((event) => event.sequence));
  }
  return received;
});

const range = (from: number, through: number) =>
  Array.from({ length: through - from + 1 }, (_, index) => from + index);

describe("makeSequencedLiveTail", () => {
  it.effect("replays to the high-water mark, then follows live commits once each", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const log = makeLog(8);
        log.commit("a");
        const raced = log.commit("a");
        const pull = yield* log.subscribe(0);
        expect(yield* pullThrough(pull, 2)).toEqual([1, 2]);

        // Sequence 2 was committed before the high-water capture but published
        // after the subscriber started buffering, so replay already covered it.
        yield* log.tail.publish([raced]);
        yield* log.tail.publish([log.commit("a")]);
        expect(yield* pullThrough(pull, 3)).toEqual([3]);
        expect(log.replays).toEqual([[0, 2]]);
      }),
    ),
  );

  it.effect("drops a stalled subscriber's buffer and recovers it exactly from the log", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const log = makeLog(4);
        log.commit("a");
        const stalled = yield* log.subscribe(0);
        const healthy = yield* log.subscribe(0);
        expect(yield* pullThrough(stalled, 1)).toEqual([1]);
        expect(yield* pullThrough(healthy, 1)).toEqual([1]);

        const healthyReceived: Array<number> = [];
        for (let index = 0; index < 40; index++) {
          yield* log.tail.publish([log.commit("a")]);
          healthyReceived.push(...(yield* pullThrough(healthy, log.committed.length)));
        }

        expect(healthyReceived).toEqual(range(2, 41));
        // The stalled subscriber held four events, then fell back to the log.
        expect(yield* pullThrough(stalled, 41)).toEqual(range(2, 41));
        expect(log.replays).toEqual([
          [0, 1],
          [0, 1],
          [5, 41],
        ]);

        // Once recovered it is live again without another replay.
        yield* log.tail.publish([log.commit("a")]);
        expect(yield* pullThrough(stalled, 42)).toEqual([42]);
        expect(log.replays).toHaveLength(3);
      }),
    ),
  );

  it.effect("never buffers other threads' events for a thread subscriber", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const log = makeLog(2);
        log.commit("a");
        const pull = yield* log.subscribe(0, "a");
        expect(yield* pullThrough(pull, 1)).toEqual([1]);

        for (let index = 0; index < 20; index++) {
          yield* log.tail.publish([log.commit("b")]);
        }
        yield* log.tail.publish([log.commit("a")]);
        expect(yield* pullThrough(pull, 22)).toEqual([22]);
        expect(log.replays).toEqual([[0, 1]]);
      }),
    ),
  );

  it.effect("recovers from the first missed event when live publishes arrive out of order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const log = makeLog(2);
        log.commit("a");
        const pull = yield* log.subscribe(0);
        expect(yield* pullThrough(pull, 1)).toEqual([1]);

        const delayed = log.commit("a");
        const [third, fourth, fifth] = [log.commit("a"), log.commit("a"), log.commit("a")];
        yield* log.tail.publish([third, fourth]);
        yield* log.tail.publish([fifth]);
        // Sequence 2 committed first but published last, after the buffer overflowed.
        yield* log.tail.publish([delayed]);

        // Re-delivering 3 and 4 is preferred over skipping 2.
        expect(yield* pullThrough(pull, 5)).toEqual([3, 4, 2, 3, 4, 5]);
        expect(log.replays).toEqual([
          [0, 1],
          [1, 5],
        ]);
      }),
    ),
  );
});
