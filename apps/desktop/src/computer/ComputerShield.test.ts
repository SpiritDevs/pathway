import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type ComputerShield,
  type ComputerShieldEngagement,
  ComputerShieldError,
  make,
} from "./ComputerShield.ts";
import {
  type FakeHelper,
  type FakeHelperSpawner,
  makeFakeHelperSpawner,
} from "./testing/FakeHelperSpawner.ts";

const FRAME = { x: 100, y: 50, width: 400, height: 300 };
const TASK = { threadId: "thread-1", turnId: "turn-1", label: "agent" };
const request = (shieldId: string, windowId = 42, pid = 7): ComputerShieldEngagement => ({
  shieldId,
  frame: FRAME,
  windowId,
  pid,
});
const engageLine = (shieldId: string, label = "") =>
  `engage ${shieldId} 100 50 400 300${label ? ` ${label}` : ""}`;

const withShield = <A, E>(
  body: (shield: ComputerShield, fake: FakeHelperSpawner) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeHelperSpawner;
    const scope = yield* Scope.make();
    const shield = yield* make({ helperPath: "/fixture/pathway-helper" }).pipe(
      Scope.provide(scope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer),
    );
    // Teardown sends `quit` and waits out the grace period on the test clock.
    const close = Effect.gen(function* () {
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* TestClock.adjust(150);
      yield* Fiber.join(closing);
    });
    return yield* body(shield, fake).pipe(Effect.ensuring(close));
  });

/** Answers one engage the way the real `--shield` helper does. */
const answerEngage = (helper: FakeHelper, shieldId: string, label = "") =>
  helper
    .awaitStdin(engageLine(shieldId, label))
    .pipe(Effect.andThen(helper.emit({ type: "shield", id: shieldId, state: "engaged" })));

/** Engages and confirms one shield, returning the helper that owns it. */
const engaged = (
  shield: ComputerShield,
  fake: FakeHelperSpawner,
  shieldId: string,
  task: typeof TASK | { threadId: string; turnId?: string },
  helper?: FakeHelper,
) =>
  Effect.gen(function* () {
    const engaging = yield* Effect.forkChild(shield.engage(request(shieldId), task));
    const owner = helper ?? (yield* fake.next);
    yield* answerEngage(owner, shieldId);
    yield* Fiber.join(engaging);
    return owner;
  });

/** `quit` is the last line `stop` writes, so every earlier command has landed. */
const stopGracefully = (shield: ComputerShield, helper: FakeHelper) =>
  Effect.gen(function* () {
    const stopping = yield* Effect.forkChild(shield.stop);
    yield* helper.awaitStdin("quit");
    yield* helper.exit(0);
    yield* Fiber.join(stopping);
  });

describe("ComputerShield", () => {
  it.effect("engages on first use and confirms before resolving", () =>
    withShield((shield, fake) =>
      Effect.gen(function* () {
        let confirmed = false;
        const engaging = yield* Effect.forkChild(
          shield.engage({ ...request("shield-1"), label: "Pathway activating Calc" }, TASK).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                confirmed = true;
              }),
            ),
          ),
        );
        const helper = yield* fake.next;
        assert.deepStrictEqual(helper.args, ["--shield"]);
        yield* helper.awaitStdin(engageLine("shield-1", "Pathway activating Calc"));
        assert.isFalse(confirmed);
        yield* helper.emit({ type: "shield", id: "shield-1", state: "engaged" });
        yield* Fiber.join(engaging);
        assert.isTrue(confirmed);
        assert.deepStrictEqual(helper.stdinLines, [
          "engage shield-1 100 50 400 300 Pathway activating Calc",
        ]);
      }),
    ),
  );

  it.effect("releases a live shield by id", () =>
    withShield((shield, fake) =>
      Effect.gen(function* () {
        const helper = yield* engaged(shield, fake, "shield-1", TASK);
        yield* shield.release("shield-1");
        yield* helper.awaitStdin("release shield-1");
        assert.deepStrictEqual(helper.stdinLines, [engageLine("shield-1"), "release shield-1"]);
      }),
    ),
  );

  it.effect("refuses an engage the helper declines instead of resolving", () =>
    withShield((shield, fake) =>
      Effect.gen(function* () {
        const engaging = yield* Effect.forkChild(
          Effect.flip(shield.engage(request("shield-1"), TASK)),
        );
        const helper = yield* fake.next;
        yield* helper.awaitStdin(engageLine("shield-1"));
        yield* helper.emit({
          type: "shield",
          id: "shield-1",
          state: "refused",
          reason: "shield-limit",
        });
        const error = yield* Fiber.join(engaging);
        assert.strictEqual(error._tag, "ComputerShieldError");
        assert.include(error.message, "refused");
      }),
    ),
  );

  it.effect("times out a wedged helper rather than waiting forever", () =>
    withShield((shield, fake) =>
      Effect.gen(function* () {
        const engaging = yield* Effect.forkChild(
          Effect.flip(shield.engage(request("shield-1"), TASK)),
        );
        const helper = yield* fake.next;
        yield* helper.awaitStdin(engageLine("shield-1"));
        yield* TestClock.adjust(5_000);
        const error = yield* Fiber.join(engaging);
        assert.include(error.message, "did not confirm");
      }),
    ),
  );

  it.effect("helper death fails a pending engage and clears the live set", () =>
    withShield((shield, fake) =>
      Effect.gen(function* () {
        const helper = yield* engaged(shield, fake, "shield-0", TASK);
        const engaging = yield* Effect.forkChild(
          Effect.flip(shield.engage(request("shield-1"), TASK)),
        );
        yield* helper.awaitStdin(engageLine("shield-1"));
        yield* helper.exit(1);
        const error = yield* Fiber.join(engaging);
        assert.include(error.message, "exited");
        // The windows died with the process, so a later releaseAll counts nothing.
        assert.strictEqual(yield* shield.releaseAll, 0);
      }),
    ),
  );

  it.effect("endTask releases the matching task's shields and remembers the end", () =>
    withShield((shield, fake) =>
      Effect.gen(function* () {
        const helper = yield* engaged(shield, fake, "shield-1", TASK);
        yield* engaged(shield, fake, "shield-2", { threadId: "other", turnId: "turn-9" }, helper);
        yield* shield.endTask({ threadId: "thread-1", turnId: "turn-1" });
        yield* helper.awaitStdin("release shield-1");
        const releases = helper.stdinLines.filter((line) => line.startsWith("release "));
        assert.deepStrictEqual(releases, ["release shield-1"]);
        // shield-2 belongs to another task and is still live.
        assert.strictEqual(yield* shield.releaseAll, 1);
      }),
    ),
  );

  it.effect("a shield confirmed after its task ended is released on arrival", () =>
    withShield((shield, fake) =>
      Effect.gen(function* () {
        // Engage without awaiting confirmation so endTask lands first.
        const engaging = yield* Effect.forkChild(shield.engage(request("shield-1"), TASK));
        const helper = yield* fake.next;
        yield* helper.awaitStdin(engageLine("shield-1"));
        yield* shield.endTask(TASK);
        yield* helper.emit({ type: "shield", id: "shield-1", state: "engaged" });
        yield* Fiber.join(engaging);
        yield* helper.awaitStdin("release shield-1");
        const releases = helper.stdinLines.filter((line) => line.startsWith("release"));
        assert.deepStrictEqual(releases, ["release shield-1"]);
        assert.strictEqual(yield* shield.releaseAll, 0);
      }),
    ),
  );

  it.effect("releaseAll drops every live shield and reports the count", () =>
    withShield((shield, fake) =>
      Effect.gen(function* () {
        const helper = yield* engaged(shield, fake, "shield-1", TASK);
        yield* engaged(shield, fake, "shield-2", { threadId: "other" }, helper);
        assert.strictEqual(yield* shield.releaseAll, 2);
        assert.strictEqual(yield* shield.releaseAll, 0);
        yield* stopGracefully(shield, helper);
        assert.strictEqual(helper.stdinLines.filter((line) => line === "release-all").length, 2);
      }),
    ),
  );

  it.effect("stop terminates the helper so its windows die with it", () =>
    withShield((shield, fake) =>
      Effect.gen(function* () {
        const first = yield* engaged(shield, fake, "shield-1", TASK);
        yield* stopGracefully(shield, first);
        assert.deepStrictEqual(first.stdinLines, [engageLine("shield-1"), "quit"]);
        assert.deepStrictEqual(first.signals, []);
        // The next engage lazily respawns a fresh helper.
        const second = yield* engaged(shield, fake, "shield-3", TASK);
        assert.notStrictEqual(second, first);
        assert.deepStrictEqual(second.stdinLines, [engageLine("shield-3")]);
      }),
    ),
  );

  it.effect("a shield engage after dispose is refused", () =>
    withShield((shield) =>
      Effect.gen(function* () {
        yield* shield.dispose;
        const error = yield* Effect.flip(shield.engage(request("shield-9"), TASK));
        assert.include(error.message, "closed");
      }),
    ),
  );

  it.effect("a helper whose spawn lands during dispose is stopped instead of engaging", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHelperSpawner;
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const gated = ChildProcessSpawner.make((command) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.andThen(fake.layer.spawn(command)),
        ),
      );
      const scope = yield* Scope.make();
      const shield = yield* make({ helperPath: "/fixture/pathway-helper" }).pipe(
        Scope.provide(scope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, gated),
      );
      const engaging = yield* Effect.forkChild(Effect.flip(shield.engage(request("late"), TASK)));
      yield* Deferred.await(entered);
      const disposing = yield* shield.dispose.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(gate, undefined);
      const helper = yield* fake.next;
      yield* Fiber.join(disposing);
      // Teardown finished only after the late helper was gone.
      assert.isTrue(helper.exitedFlag());
      assert.deepStrictEqual(helper.stdinLines, []);
      const error = yield* Fiber.join(engaging);
      assert.instanceOf(error, ComputerShieldError);
      assert.strictEqual(error.reason, "stopped");
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
