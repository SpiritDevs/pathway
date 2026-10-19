import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * Matching events a subscriber may hold before it is treated as lagging. Kept
 * equal to the replay page size so a lagging subscriber holds about one page
 * of payloads whichever path it is reading from.
 */
export const LIVE_TAIL_CAPACITY = 256;

export interface SequencedLiveTail<A extends { readonly sequence: number }> {
  /** Offers committed events to every live subscriber. Never blocks the committer. */
  readonly publish: (events: ReadonlyArray<A>) => Effect.Effect<void>;
  /**
   * Replays durable events after `afterSequence`, then follows live commits.
   * `replay` must return the durable events in `(after, through]` that pass
   * `accepts`, in sequence order.
   */
  readonly stream: <E, R>(input: {
    readonly afterSequence: number;
    readonly accepts?: (event: A) => boolean;
    readonly highWater: Effect.Effect<number, E, R>;
    readonly replay: (afterSequence: number, throughSequence: number) => Stream.Stream<A, E, R>;
  }) => Stream.Stream<A, E, R>;
}

interface Subscriber<A> {
  readonly accepts: ((event: A) => boolean) | undefined;
  /** `undefined` while lagging: nothing is buffered until the next replay. */
  queue: Queue.Queue<A, Cause.Done> | undefined;
  /** Lowest sequence not buffered since the subscriber started lagging. */
  lowestMissed: number;
}

/**
 * Live tail for an append-only, sequence-numbered event log.
 *
 * Each subscriber buffers at most `capacity` matching events. One that falls
 * further behind drops its buffer and resumes from its last delivered sequence
 * through the durable replay, so a slow client costs bounded memory, never
 * blocks commits, and never loses events.
 */
export const makeSequencedLiveTail = <A extends { readonly sequence: number }>(
  capacity = LIVE_TAIL_CAPACITY,
): SequencedLiveTail<A> => {
  const subscribers = new Set<Subscriber<A>>();

  const offer = (subscriber: Subscriber<A>, events: ReadonlyArray<A>) => {
    const matching = subscriber.accepts === undefined ? events : events.filter(subscriber.accepts);
    if (matching.length === 0) return;
    const missed =
      subscriber.queue === undefined ? matching : Queue.offerAllUnsafe(subscriber.queue, matching);
    if (missed.length === 0) return;
    for (const event of missed) {
      subscriber.lowestMissed = Math.min(subscriber.lowestMissed, event.sequence);
    }
    if (subscriber.queue !== undefined) {
      // Already-buffered events stay readable; the end then triggers a replay.
      Queue.endUnsafe(subscriber.queue);
      subscriber.queue = undefined;
    }
  };

  const publish = (events: ReadonlyArray<A>) =>
    Effect.sync(() => {
      if (events.length === 0) return;
      for (const subscriber of subscribers) offer(subscriber, events);
    });

  const stream: SequencedLiveTail<A>["stream"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscriber: Subscriber<A> = {
          accepts: input.accepts,
          queue: undefined,
          lowestMissed: Number.POSITIVE_INFINITY,
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => subscribers.add(subscriber)),
          () => Effect.sync(() => subscribers.delete(subscriber)),
        );
        let delivered = input.afterSequence;

        // Buffer first, then capture the durable high-water mark, so a commit
        // landing in between is either replayed or buffered, never missed.
        // A round ends only when its buffer overflows; the next round replays
        // from the last delivered sequence, or from the first missed event if
        // live publishes arrived out of sequence order.
        const round = Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Queue.make<A, Cause.Done>({ capacity, strategy: "dropping" });
            const resumeAfter = Math.max(
              input.afterSequence,
              Math.min(delivered, subscriber.lowestMissed - 1),
            );
            subscriber.queue = queue;
            subscriber.lowestMissed = Number.POSITIVE_INFINITY;
            const highWater = yield* input.highWater;
            const liveAfter = Math.max(highWater, resumeAfter);
            return Stream.concat(
              input.replay(resumeAfter, highWater),
              Stream.fromQueue(queue).pipe(Stream.filter((event) => event.sequence > liveAfter)),
            );
          }),
        );

        return Stream.forever(round).pipe(
          Stream.map((event) => {
            delivered = Math.max(delivered, event.sequence);
            return event;
          }),
        );
      }),
    );

  return { publish, stream };
};
