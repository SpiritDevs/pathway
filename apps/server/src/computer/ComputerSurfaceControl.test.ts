import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, PubSub, Stream } from "effect";
import { type ComputerSurfaceState } from "@spiritdevs/contracts";
import { ComputerSurfaceControl } from "./ComputerSurfaceControl.ts";
import { DesktopOperationQueue } from "./DesktopOperationQueue.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { ComputerBackendError } from "./computerErrors.ts";

const fixture = Effect.gen(function* () {
  const queue = new DesktopOperationQueue();
  const updates = yield* PubSub.sliding<ComputerSurfaceState>(1);
  let stops = 0;
  const control = new ComputerSurfaceControl(
    "desktop",
    queue,
    updates,
    () => ({ capture: true, input: true, pointerPhases: false }),
    () =>
      Effect.sync(() => {
        stops++;
      }),
  );
  return { control, queue, stops: () => stops };
});
const start = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkChild(effect, { startImmediately: true });

it.effect("streams initial ownership, simultaneous turns and the reverse handoff", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { control } = yield* fixture;
      const initial = yield* Stream.runCollect(control.changes.pipe(Stream.take(1)));
      expect(initial[0]?.controller).toEqual({ kind: "idle" });
      control.startTurn("a", "run-a");
      control.startTurn("b", "run-b");
      yield* control.take("client-a");
      control.endTurn("a", "stale-run");
      expect(control.snapshot.activeTurns).toHaveLength(2);
      control.endTurn("a", "run-a");
      control.endTurn("b", "run-b");
      expect(control.snapshot.controller).toEqual({ kind: "client", clientId: "client-a" });
      yield* control.release("client-a");
      expect(control.snapshot.controller).toEqual({ kind: "idle" });
    }),
  ),
);

it.effect(
  "drains an active agent, moves prequeued agents out of the queue and resumes them after release",
  () =>
    Effect.gen(function* () {
      const { control, queue } = yield* fixture;
      const active = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const first = yield* start(
        control.withAgentControl(
          (a) => queue.run(a),
          Deferred.succeed(active, undefined).pipe(Effect.andThen(Deferred.await(done))),
        ),
      );
      yield* Deferred.await(active);
      let resumed = false;
      const second = yield* start(
        control.withAgentControl(
          (a) => queue.run(a),
          Effect.sync(() => {
            resumed = true;
          }),
        ),
      );
      const take = yield* start(control.take("human"));
      expect(take.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(take);
      expect(resumed).toBe(false);
      yield* control.input("human", { type: "type", text: "secret" }, Effect.void);
      yield* control.release("human");
      yield* Fiber.join(second);
      expect(resumed).toBe(true);
    }),
);

it.effect("admits one controller and refuses input and handback from every other connection", () =>
  Effect.gen(function* () {
    const { control } = yield* fixture;
    expect(
      (yield* Effect.flip(control.input("a", { type: "key", key: "A" }, Effect.void))).message,
    ).toContain("does not hold");
    yield* control.take("a");
    yield* control.take("a");
    yield* Effect.flip(control.take("b"));
    yield* Effect.flip(control.release("b"));
    yield* Effect.flip(
      control.input("b", { type: "key", key: "A" }, Effect.die("must not execute")),
    );
    yield* Effect.flip(control.assertUnclaimed());
    yield* control.disconnect("b");
    expect(control.snapshot.controller).toEqual({ kind: "client", clientId: "a" });
    yield* control.disconnect("a");
    yield* control.assertUnclaimed();
  }),
);

it.effect(
  "hands back only after accepted input drains, bounds the log and retains control on capture failure",
  () =>
    Effect.gen(function* () {
      const { control } = yield* fixture;
      yield* control.take("a");
      for (let i = 0; i < 40; i++)
        yield* control.input("a", { type: "type", text: "password" }, Effect.void);
      yield* Effect.flip(
        control.handBack("a", () =>
          Effect.fail(new ComputerBackendError({ message: "capture failed" })),
        ),
      );
      expect(control.snapshot.controller.kind).toBe("client");
      const entered = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const input = yield* start(
        control.input(
          "a",
          { type: "pointer.click", x: 12, y: 34 },
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(done))),
        ),
      );
      yield* Deferred.await(entered);
      const back = yield* start(control.handBack("a", (summary) => Effect.succeed(summary)));
      expect(back.pollUnsafe()).toBeUndefined();
      yield* Effect.flip(control.input("a", { type: "key", key: "A" }, Effect.void));
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(input);
      const summary = yield* Fiber.join(back);
      expect(summary).toContain("9 earlier actions omitted");
      expect(summary).toContain("pointer.click at (12, 34)");
      expect(summary).not.toContain("password");
      expect(summary.split("\n")).toHaveLength(34);
      expect(control.snapshot.controller.kind).toBe("idle");
    }),
);

it.effect("disconnect aborts in-flight and queued input before waking waiting agents", () =>
  Effect.gen(function* () {
    const { control, queue, stops } = yield* fixture;
    yield* control.take("a");
    const entered = yield* Deferred.make<void>();
    const input = yield* start(
      control
        .input(
          "a",
          { type: "key", key: "A" },
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    const queued = yield* start(
      control
        .input("a", { type: "key", key: "B" }, Effect.die("must not execute"))
        .pipe(Effect.exit),
    );
    const agent = yield* start(
      control.withAgentControl((a) => queue.run(a), Effect.succeed("resumed")),
    );
    yield* control.disconnect("a");
    expect((yield* Fiber.join(input))._tag).toBe("Failure");
    expect((yield* Fiber.join(queued))._tag).toBe("Failure");
    expect(yield* Fiber.join(agent)).toBe("resumed");
    expect(stops()).toBe(1);
  }),
);

it.layer(NodeServices.layer)("manager surface admission", (it) => {
  it.effect("rechecks durable consent when a paused agent resumes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ComputerManager.make({ backend: new FakeComputerBackend() });
        yield* manager.surfaceControl.take("a");
        const agent = yield* start(
          manager.withAgentActivity("thread", Effect.die("revoked action ran")).pipe(Effect.exit),
        );
        yield* manager.setControlEnabled("thread", false);
        yield* manager.surfaceControl.release("a");
        expect((yield* Fiber.join(agent))._tag).toBe("Failure");
      }),
    ),
  );
  it.effect("Escape bypasses a changed input policy and cancels paused agents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ComputerManager.make({ backend: new FakeComputerBackend() });
        yield* manager.surfaceControl.take("a");
        const agent = yield* start(
          manager.withAgentActivity("thread", Effect.die("stopped action ran")).pipe(Effect.exit),
        );
        yield* manager.surfaceInput(
          "a",
          { type: "key", key: "Escape" },
          Effect.fail({ message: "policy revoked" }),
        );
        expect((yield* Fiber.join(agent))._tag).toBe("Failure");
        expect(manager.surfaceControl.snapshot.controller.kind).toBe("idle");
      }),
    ),
  );
});
