import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { ComputerBackendError } from "./computerErrors.ts";
import {
  DESKTOP_OPERATION_QUEUE_LIMIT,
  DesktopOperationQueue,
  abortDesktop,
  awaitDesktopSignal,
  desktopOperationSignal,
  desktopSignal,
  isDesktopSignalAborted,
  makeDesktopAbort,
  withDesktopOperationSignal,
} from "./DesktopOperationQueue.ts";

const reason = (message = "cancelled") => new ComputerBackendError({ message });

const failureMessage = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? String((Cause.squash(exit.cause) as Error).message) : "";

describe("DesktopOperationQueue", () => {
  it.effect(
    "holds the desktop until input and observation finish, then recovers after a failure",
    () =>
      Effect.gen(function* () {
        const queue = new DesktopOperationQueue();
        const held = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const events: string[] = [];
        const first = yield* Effect.forkChild(
          queue.run(
            Effect.gen(function* () {
              yield* queue.run(Effect.sync(() => events.push("input")));
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(held);
              events.push("observation");
              return yield* reason("capture failed");
            }),
          ),
        );
        yield* Deferred.await(entered);
        const second = yield* Effect.forkChild(
          queue.run(Effect.sync(() => events.push("next input"))),
        );
        yield* Effect.yieldNow;
        expect(events).toEqual(["input"]);
        yield* Deferred.succeed(held, undefined);
        expect(failureMessage(yield* Fiber.await(first))).toBe("capture failed");
        yield* Fiber.join(second);
        expect(events).toEqual(["input", "observation", "next input"]);
      }),
  );

  it.effect("skips an aborted operation before it can send input", () =>
    Effect.gen(function* () {
      const queue = new DesktopOperationQueue();
      const held = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(queue.run(Deferred.await(held)));
      const abort = makeDesktopAbort();
      let ran = false;
      const second = yield* Effect.forkChild(
        queue.run(
          Effect.sync(() => {
            ran = true;
          }),
          desktopSignal(abort),
        ),
      );
      yield* Effect.yieldNow;
      yield* abortDesktop(abort, reason());
      yield* Deferred.succeed(held, undefined);
      yield* Fiber.join(first);
      expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true);
      expect(ran).toBe(false);
    }),
  );

  it.effect.each(["inherited", "explicit"] as const)(
    "preserves %s cancellation when an operation also has the other signal",
    (cancelledScope) =>
      Effect.gen(function* () {
        const queue = new DesktopOperationQueue();
        const held = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(queue.run(Deferred.await(held)));
        const inherited = makeDesktopAbort();
        const explicit = makeDesktopAbort();
        let ran = false;
        const second = yield* Effect.forkChild(
          withDesktopOperationSignal(
            desktopSignal(inherited),
            queue.run(
              Effect.sync(() => {
                ran = true;
              }),
              desktopSignal(explicit),
            ),
          ),
        );
        yield* Effect.yieldNow;
        yield* abortDesktop(cancelledScope === "inherited" ? inherited : explicit, reason());
        yield* Deferred.succeed(held, undefined);
        yield* Fiber.join(first);
        expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true);
        expect(ran).toBe(false);
        yield* queue.close;
      }),
  );

  it.effect("composes reentrant cancellation without losing the outer transaction", () =>
    Effect.gen(function* () {
      const queue = new DesktopOperationQueue();
      const inner = makeDesktopAbort();
      yield* queue.run(
        Effect.gen(function* () {
          const outerSignal = yield* desktopOperationSignal;
          // Aborting the inner signal interrupts the nested operation with its
          // reason; the outer transaction keeps running under its own signal.
          const nested = yield* Effect.exit(
            queue.run(
              Effect.gen(function* () {
                const nestedSignal = yield* desktopOperationSignal;
                expect(isDesktopSignalAborted(nestedSignal)).toBe(false);
                yield* abortDesktop(inner, reason("inner"));
                expect(isDesktopSignalAborted(nestedSignal)).toBe(true);
                return yield* Effect.never;
              }),
              desktopSignal(inner),
            ),
          );
          expect(failureMessage(nested)).toBe("inner");
          expect(yield* desktopOperationSignal).toBe(outerSignal);
          expect(isDesktopSignalAborted(outerSignal)).toBe(false);
        }),
      );
      yield* queue.close;
    }),
  );

  it.effect("runs independent scoped targets concurrently and orders the same target", () =>
    Effect.gen(function* () {
      const queue = new DesktopOperationQueue();
      const releaseA = yield* Deferred.make<void>();
      const releaseB = yield* Deferred.make<void>();
      const enteredA = yield* Deferred.make<void>();
      const enteredB = yield* Deferred.make<void>();
      const events: string[] = [];

      const firstA = yield* Effect.forkChild(
        queue.runScoped(
          "window-a",
          Effect.gen(function* () {
            events.push("a1");
            yield* Deferred.succeed(enteredA, undefined);
            yield* Deferred.await(releaseA);
          }),
        ),
      );
      const secondA = yield* Effect.forkChild(
        queue.runScoped(
          "window-a",
          Effect.sync(() => events.push("a2")),
        ),
      );
      const firstB = yield* Effect.forkChild(
        queue.runScoped(
          "window-b",
          Effect.gen(function* () {
            events.push("b1");
            yield* Deferred.succeed(enteredB, undefined);
            yield* Deferred.await(releaseB);
          }),
        ),
      );

      yield* Deferred.await(enteredA);
      yield* Deferred.await(enteredB);
      expect(events).toEqual(["a1", "b1"]);
      yield* Deferred.succeed(releaseA, undefined);
      yield* Fiber.join(firstA);
      yield* Fiber.join(secondA);
      expect(events).toEqual(["a1", "b1", "a2"]);
      yield* Deferred.succeed(releaseB, undefined);
      yield* Fiber.join(firstB);
      yield* queue.close;
    }),
  );

  it.effect("keeps exclusive work ahead of later scoped admissions", () =>
    Effect.gen(function* () {
      const queue = new DesktopOperationQueue();
      const releaseScoped = yield* Deferred.make<void>();
      const enteredScoped = yield* Deferred.make<void>();
      const events: string[] = [];
      const scoped = yield* Effect.forkChild(
        queue.runScoped(
          "window-a",
          Effect.gen(function* () {
            events.push("scoped");
            yield* Deferred.succeed(enteredScoped, undefined);
            yield* Deferred.await(releaseScoped);
          }),
        ),
      );
      yield* Deferred.await(enteredScoped);

      const exclusive = yield* Effect.forkChild(
        queue.run(Effect.sync(() => events.push("exclusive"))),
      );
      const laterScoped = yield* Effect.forkChild(
        queue.runScoped(
          "window-b",
          Effect.sync(() => events.push("later scoped")),
        ),
      );
      yield* Effect.yieldNow;
      expect(events).toEqual(["scoped"]);

      yield* Deferred.succeed(releaseScoped, undefined);
      yield* Fiber.joinAll([scoped, exclusive, laterScoped]);
      expect(events).toEqual(["scoped", "exclusive", "later scoped"]);
      yield* queue.close;
    }),
  );

  it.effect("does not let exclusive work overtake an earlier same-target operation", () =>
    Effect.gen(function* () {
      const queue = new DesktopOperationQueue();
      const releaseFirst = yield* Deferred.make<void>();
      const enteredFirst = yield* Deferred.make<void>();
      const events: string[] = [];
      const first = yield* Effect.forkChild(
        queue.runScoped(
          "window-a",
          Effect.gen(function* () {
            events.push("first");
            yield* Deferred.succeed(enteredFirst, undefined);
            yield* Deferred.await(releaseFirst);
          }),
        ),
      );
      yield* Deferred.await(enteredFirst);
      const second = yield* Effect.forkChild(
        queue.runScoped(
          "window-a",
          Effect.sync(() => events.push("second")),
        ),
      );
      const exclusive = yield* Effect.forkChild(
        queue.run(Effect.sync(() => events.push("exclusive"))),
      );

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.joinAll([first, second, exclusive]);
      expect(events).toEqual(["first", "second", "exclusive"]);
      yield* queue.close;
    }),
  );

  it.effect("bounds the backlog and cancels active input before closing", () =>
    Effect.gen(function* () {
      const queue = new DesktopOperationQueue();
      const entered = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        queue.run(Effect.andThen(Deferred.succeed(entered, undefined), Effect.never)),
      );
      yield* Deferred.await(entered);
      let queuedRuns = 0;
      const waiting = yield* Effect.forEach(
        Array.from({ length: DESKTOP_OPERATION_QUEUE_LIMIT - 1 }),
        () =>
          Effect.forkChild(
            queue.run(
              Effect.sync(() => {
                queuedRuns += 1;
              }),
            ),
          ),
      );
      yield* Effect.yieldNow;
      const overflow = yield* Effect.exit(queue.run(Effect.void));
      expect(failureMessage(overflow)).toContain("Too many");
      yield* queue.close;
      expect(failureMessage(yield* Fiber.await(first))).toContain("closed");
      for (const fiber of waiting) {
        expect(failureMessage(yield* Fiber.await(fiber))).toContain("closed");
      }
      expect(queuedRuns).toBe(0);
      expect(failureMessage(yield* Effect.exit(queue.run(Effect.void)))).toContain("closed");
    }),
  );
});

it.effect("cancels running native work before completing shutdown", () =>
  Effect.gen(function* () {
    const queue = new DesktopOperationQueue();
    const entered = yield* Deferred.make<void>();
    let signalled = false;
    const running = yield* Effect.forkChild(
      queue.run(
        Effect.gen(function* () {
          const signal = yield* desktopOperationSignal;
          yield* Deferred.succeed(entered, undefined);
          return yield* awaitDesktopSignal(signal).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                signalled = isDesktopSignalAborted(signal);
              }),
            ),
          );
        }),
      ),
    );
    yield* Deferred.await(entered);
    yield* queue.close;
    expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true);
    expect(signalled).toBe(true);
  }),
);

it.effect("does not retain a cancelled turn's signal in detached background work", () =>
  Effect.gen(function* () {
    const queue = new DesktopOperationQueue();
    const abort = makeDesktopAbort();
    const release = yield* Deferred.make<void>();
    const detached = yield* queue.run(
      Effect.gen(function* () {
        expect(isDesktopSignalAborted(yield* desktopOperationSignal)).toBe(false);
        return yield* Effect.forkDetach(
          Effect.andThen(Deferred.await(release), desktopOperationSignal),
        );
      }),
      desktopSignal(abort),
    );
    yield* abortDesktop(abort, reason());
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(detached)).toBeUndefined();
    yield* queue.close;
  }),
);

it.effect("expires a composed operation signal before detached cosmetic work resumes", () =>
  Effect.gen(function* () {
    const abort = makeDesktopAbort();
    const signal = desktopSignal(abort);
    const release = yield* Deferred.make<void>();
    const detached = yield* withDesktopOperationSignal(
      signal,
      Effect.gen(function* () {
        expect(yield* desktopOperationSignal).toBe(signal);
        return yield* Effect.forkDetach(
          Effect.andThen(Deferred.await(release), desktopOperationSignal),
        );
      }),
    );
    yield* abortDesktop(abort, reason());
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(detached)).toBeUndefined();
  }),
);
