import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId, type DeviceControlOwner } from "@spiritdevs/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { DEVICE_CONTROL_TTL, make, type DeviceControlGrant } from "./DeviceControl.ts";
const target = { hostId: "local", deviceId: "phone" };
const viewer = (viewerId: string, sessionId = "session"): DeviceControlOwner => ({
  kind: "viewer",
  sessionId,
  viewerId,
});
const agent: DeviceControlOwner = {
  kind: "agent",
  threadId: ThreadId.make("thread"),
  runId: RunId.make("run"),
};

describe("environment device control", () => {
  it.effect("caller cancellation still waits for native completion before takeover", () =>
    Effect.gen(function* () {
      const draining = yield* Deferred.make<void>();
      const control = yield* make((states) =>
        states.some((state) => state.phase === "draining" && state.owner?.kind === "agent")
          ? Deferred.succeed(draining, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      const held = yield* control.acquire(target, agent);
      const started = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      let finished = false;
      const command = yield* control
        .run(
          { ...target, owner: agent, generation: held.generation },
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(done)),
            Effect.ensuring(
              Effect.sync(() => {
                finished = true;
              }),
            ),
          ),
          "agent",
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const canceled = yield* Fiber.interrupt(command).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const takeover = yield* control.acquire(target, viewer("next")).pipe(Effect.forkChild);
      yield* Deferred.await(draining);
      expect(finished).toBe(false);
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(canceled);
      expect((yield* Fiber.join(takeover)).phase).toBe("held");
      expect(finished).toBe(true);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "fences an agent immediately and acknowledges a viewer only after the command receipt",
    () =>
      Effect.gen(function* () {
        const draining = yield* Deferred.make<void>();
        const control = yield* make((states) =>
          states.some((state) => state.phase === "draining" && state.owner?.kind === "agent")
            ? Deferred.succeed(draining, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        const held = yield* control.acquire(target, agent);
        const grant = { ...target, owner: agent, generation: held.generation };
        const started = yield* Deferred.make<void>();
        const done = yield* Deferred.make<void>();
        const command = yield* control
          .run(
            grant,
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(done))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        let acknowledged = false;
        const takeover = yield* control.acquire(target, viewer("one")).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              acknowledged = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(draining);
        expect(acknowledged).toBe(false);
        expect((yield* control.run(grant, Effect.void).pipe(Effect.flip)).code).toBe(
          "control_draining",
        );
        yield* Deferred.succeed(done, undefined);
        yield* Fiber.join(command);
        const owned = yield* Fiber.join(takeover);
        expect(acknowledged).toBe(true);
        expect(owned.owner).toEqual(viewer("one"));
        expect((yield* control.assert(grant).pipe(Effect.flip)).code).toBe("stale_generation");
      }).pipe(Effect.scoped),
  );

  it.effect("distinguishes viewers in one session, sessions, hosts, and agent runs", () =>
    Effect.gen(function* () {
      const control = yield* make();
      const state = yield* control.acquire(target, viewer("one"));
      const grant = { ...target, owner: viewer("one"), generation: state.generation };
      for (const owner of [viewer("two"), viewer("one", "other")])
        expect((yield* control.run({ ...grant, owner }, Effect.void).pipe(Effect.flip)).code).toBe(
          "control_held",
        );
      expect((yield* control.acquire(target, agent).pipe(Effect.flip)).code).toBe("control_held");
      yield* control.acquire({ ...target, hostId: "remote" }, agent);
      const renew = yield* control.renew(grant);
      expect(renew.generation).toBe(state.generation);
      const released = yield* control.release(grant);
      expect(released.owner).toBeNull();
      expect(released.generation).toBeGreaterThan(state.generation);
      const resumed = yield* control.acquire(target, agent);
      const otherRun = { ...agent, runId: RunId.make("other") } as DeviceControlOwner;
      expect((yield* control.acquire(target, otherRun).pipe(Effect.flip)).code).toBe(
        "control_held",
      );
      yield* control.stopRun("thread", "run");
      expect(
        (yield* control
          .assert({ ...target, owner: agent, generation: resumed.generation })
          .pipe(Effect.flip)).code,
      ).toBe("run_stopped");
      expect((yield* control.acquire(target, agent).pipe(Effect.flip)).code).toBe("run_stopped");
      yield* control.acquire(target, otherRun);
    }).pipe(Effect.scoped),
  );

  it.effect("finishes held input before hand-back and rejects old generations", () =>
    Effect.gen(function* () {
      const control = yield* make();
      const state = yield* control.acquire(target, viewer("one"));
      const grant: DeviceControlGrant = {
        ...target,
        owner: viewer("one"),
        generation: state.generation,
      };
      const finishStarted = yield* Deferred.make<void>();
      const finishDone = yield* Deferred.make<void>();
      yield* control.onFinish(
        grant,
        Deferred.succeed(finishStarted, undefined).pipe(Effect.andThen(Deferred.await(finishDone))),
      );
      const handback = yield* control.release(grant).pipe(Effect.forkChild);
      yield* Deferred.await(finishStarted);
      expect((yield* control.state)[0]?.phase).toBe("draining");
      expect((yield* control.run(grant, Effect.void).pipe(Effect.flip)).code).toBe(
        "control_draining",
      );
      yield* Deferred.succeed(finishDone, undefined);
      expect((yield* Fiber.join(handback)).phase).toBe("idle");
      expect((yield* control.renew(grant).pipe(Effect.flip)).code).toBe("stale_generation");
    }).pipe(Effect.scoped),
  );

  it.effect("expires without client activity; renewal does not let an old timer revoke it", () =>
    Effect.gen(function* () {
      const expired = yield* Deferred.make<void>();
      let wasHeld = false;
      const control = yield* make((states) =>
        Effect.gen(function* () {
          if (states[0]?.phase === "held") wasHeld = true;
          if (wasHeld && states[0]?.phase === "idle") yield* Deferred.succeed(expired, undefined);
        }),
      );
      const state = yield* control.acquire(target, viewer("one"));
      const grant = { ...target, owner: viewer("one"), generation: state.generation };
      yield* TestClock.adjust(DEVICE_CONTROL_TTL / 2);
      yield* control.renew(grant);
      yield* TestClock.adjust(DEVICE_CONTROL_TTL / 2);
      yield* control.assert(grant);
      yield* TestClock.adjust(DEVICE_CONTROL_TTL / 2);
      yield* Deferred.await(expired);
      expect((yield* control.assert(grant).pipe(Effect.flip)).code).toBe("stale_generation");
    }).pipe(Effect.scoped),
  );

  it.effect("disconnect, revocation, shutdown, and host replacement revoke authority", () =>
    Effect.gen(function* () {
      const control = yield* make();
      for (const invalidate of [
        () => control.disconnect("session", "one"),
        () => control.disconnect("session"),
        () => control.invalidate(target),
        () => control.invalidateHost("local"),
      ]) {
        const held = yield* control.acquire(target, viewer("one"));
        yield* invalidate();
        expect(
          (yield* control
            .assert({ ...target, owner: viewer("one"), generation: held.generation })
            .pipe(Effect.flip)).code,
        ).toBe("stale_generation");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("uncertain completion never acknowledges takeover until old helpers have stopped", () =>
    Effect.gen(function* () {
      const control = yield* make();
      yield* control.acquire(target, agent);
      yield* control.uncertain(target);
      expect((yield* control.acquire(target, viewer("one")).pipe(Effect.flip)).code).toBe(
        "input_unconfirmed",
      );
      expect((yield* control.state)[0]?.phase).toBe("draining");
      yield* control.hostStopped("local");
      expect((yield* control.acquire(target, viewer("one"))).phase).toBe("held");
    }).pipe(Effect.scoped),
  );

  it.effect("a queued disconnect does not revoke the viewer taking over", () =>
    Effect.gen(function* () {
      const control = yield* make();
      const owned = yield* control.acquire(target, viewer("one"));
      const finishing = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      yield* control.onFinish(
        { ...target, owner: viewer("one"), generation: owned.generation },
        Deferred.succeed(finishing, undefined).pipe(Effect.andThen(Deferred.await(finished))),
      );
      const takeover = yield* control
        .acquire(target, viewer("two", "new-session"))
        .pipe(Effect.forkChild);
      yield* Deferred.await(finishing);
      const disconnect = yield* control.disconnect("session").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(finished, undefined);
      const next = yield* Fiber.join(takeover);
      yield* Fiber.join(disconnect);
      yield* control.assert({
        ...target,
        owner: viewer("two", "new-session"),
        generation: next.generation,
      });
    }).pipe(Effect.scoped),
  );
});
