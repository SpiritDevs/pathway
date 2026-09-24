import { EventEmitter } from "node:events";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ComputerBackendError } from "./computerErrors.ts";
import { withFakeDbusTransport } from "./computerPluginTestDoubles.ts";
import { isConnectionLevelFailure } from "./dbusFailures.ts";
import {
  DbusCallError,
  DbusConnectionClosedError,
  unwrapDbusValue,
  watchDbusConnection,
  withDbusTimeout,
} from "./dbusPlumbing.ts";

/** Stands in for a call site's own error type, recovery marker and all. */
class SiteError extends Schema.TaggedErrorClass<SiteError>()("SiteError", {
  message: Schema.String,
}) {
  readonly connectionLevel = true;
}

describe("unwrapping a D-Bus value", () => {
  it("sees through however many variant layers wrapped it", () => {
    const nested = { signature: "v", value: { signature: "s", value: "ok" } };
    expect(unwrapDbusValue(nested)).toBe("ok");
  });

  it("leaves a plain value, and a look-alike without a signature, alone", () => {
    expect(unwrapDbusValue(["a", "b"])).toEqual(["a", "b"]);
    expect(unwrapDbusValue({ value: "not a variant" })).toEqual({ value: "not a variant" });
    expect(unwrapDbusValue(null)).toBeNull();
  });
});

describe("racing a D-Bus call against a timeout", () => {
  it.effect("fails with exactly the error the caller's factory built", () =>
    Effect.gen(function* () {
      const pending = yield* Effect.forkChild(
        Effect.flip(
          withDbusTimeout(
            Effect.never,
            5_000,
            () => new SiteError({ message: "Method timed out after 5000 ms." }),
          ),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust("5000 millis");
      const error = yield* Fiber.join(pending);
      expect(error).toBeInstanceOf(SiteError);
      expect(error.message).toBe("Method timed out after 5000 ms.");
      expect(error.connectionLevel).toBe(true);
    }),
  );

  it.effect("does not fire early, and builds the error only on expiry", () =>
    Effect.gen(function* () {
      let built = 0;
      const pending = yield* Effect.forkChild(
        Effect.flip(
          withDbusTimeout(Effect.never, 5_000, () => {
            built += 1;
            return new SiteError({ message: "late" });
          }),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust("4999 millis");
      expect(built).toBe(0);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(pending);
      expect(built).toBe(1);
    }),
  );

  it.effect("answers as soon as the call does, without waiting out the deadline", () =>
    Effect.gen(function* () {
      const answer = yield* withDbusTimeout(
        Effect.succeed("ok"),
        5_000,
        () => new SiteError({ message: "no" }),
      );
      expect(answer).toBe("ok");
    }),
  );

  it.effect("passes a reported failure through untouched", () =>
    Effect.gen(function* () {
      const reported = new DbusCallError({
        message: "no owner",
        type: "org.freedesktop.DBus.Error.ServiceUnknown",
      });
      const error = yield* Effect.flip(
        withDbusTimeout(Effect.fail(reported), 5_000, () => new SiteError({ message: "no" })),
      );
      expect(error).toBe(reported);
    }),
  );
});

describe("watching a D-Bus connection", () => {
  it.effect("fails a waiting call and everything after it the moment the transport ends", () =>
    Effect.gen(function* () {
      const bus = withFakeDbusTransport(new EventEmitter());
      const watch = watchDbusConnection(bus);
      let closed = 0;
      watch.onClosed(() => {
        closed += 1;
      });
      const waiting = yield* Effect.forkChild(Effect.flip(watch.guard(Effect.never)), {
        startImmediately: true,
      });

      bus.dropTransport();

      // dbus-next reports none of this itself: no `disconnect`, no rejection.
      const error = yield* Fiber.join(waiting);
      expect(error).toBeInstanceOf(DbusConnectionClosedError);
      expect(isConnectionLevelFailure(error)).toBe(true);
      // `end` then the socket's `close`, and a late bus error: one closure.
      bus.emit("error", new Error("read ECONNRESET"));
      expect(closed).toBe(1);
      expect(watch.isClosed()).toBe(true);

      let started = 0;
      const late = yield* Effect.flip(
        watch.guard(Effect.suspend(() => ((started += 1), Effect.never))),
      );
      expect(late).toBeInstanceOf(DbusConnectionClosedError);
      expect(started).toBe(0);
    }),
  );

  it.effect("treats a bus error as the connection closing, with the error as its cause", () =>
    Effect.gen(function* () {
      const bus = new EventEmitter();
      const watch = watchDbusConnection(bus);
      const reset = new Error("read ECONNRESET");
      const waiting = yield* Effect.forkChild(Effect.flip(watch.guard(Effect.never)), {
        startImmediately: true,
      });
      bus.emit("error", reset);
      const error = yield* Fiber.join(waiting);
      expect(error).toMatchObject({ cause: reset, connectionLevel: true });
    }),
  );

  it.effect("keeps the connection through errors about one message", () =>
    Effect.gen(function* () {
      const bus = withFakeDbusTransport(new EventEmitter());
      const watch = watchDbusConnection(bus);
      let closed = 0;
      watch.onClosed(() => {
        closed += 1;
      });
      const answer = yield* Deferred.make<string>();
      const waiting = yield* Effect.forkChild(watch.guard(Deferred.await(answer)), {
        startImmediately: true,
      });

      // An undecodable message: dbus-next adds a description and reads on.
      bus.emit("error", new TypeError("bad variant"), "There was an error receiving a message");
      // A failed AddMatch/RemoveMatch reply: a DBusError, named by `type`.
      const refused = Object.assign(new Error("match rule refused"), {
        name: "DBusError",
        type: "org.freedesktop.DBus.Error.MatchRuleInvalid",
        reply: null,
      });
      bus.emit("error", refused);

      expect(watch.isClosed()).toBe(false);
      expect(closed).toBe(0);
      yield* Deferred.succeed(answer, "still here");
      expect(yield* Fiber.join(waiting)).toBe("still here");

      // A socket error still ends it.
      bus.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      expect(watch.isClosed()).toBe(true);
      expect(closed).toBe(1);
    }),
  );

  it.effect(
    "settles a released connection's calls with the releaser's reason and tells no one",
    () =>
      Effect.gen(function* () {
        const bus = withFakeDbusTransport(new EventEmitter());
        const watch = watchDbusConnection(bus);
        let closed = 0;
        watch.onClosed(() => {
          closed += 1;
        });
        const waiting = yield* Effect.forkChild(Effect.flip(watch.guard(Effect.never)), {
          startImmediately: true,
        });
        const reason = new ComputerBackendError({ message: "released", retryable: true });

        watch.release(reason);
        bus.dropTransport();

        expect(yield* Fiber.join(waiting)).toBe(reason);
        expect(yield* Effect.flip(watch.guard(Effect.never))).toBe(reason);
        expect(closed).toBe(0);
      }),
  );

  it.effect("passes answers and refusals through", () =>
    Effect.gen(function* () {
      const bus = new EventEmitter();
      const watch = watchDbusConnection(bus);
      expect(yield* watch.guard(Effect.succeed("ok"))).toBe("ok");
      const refused = new DbusCallError({
        message: "bad args",
        type: "org.freedesktop.DBus.Error.InvalidArgs",
      });
      expect(yield* Effect.flip(watch.guard(Effect.fail(refused)))).toBe(refused);
      expect(watch.isClosed()).toBe(false);
    }),
  );

  it("keeps a throwing listener from escaping into the socket's emit", () => {
    const bus = withFakeDbusTransport(new EventEmitter());
    const watch = watchDbusConnection(bus);
    watch.onClosed(() => {
      throw new Error("listener bug");
    });
    expect(() => bus.dropTransport()).not.toThrow();
  });
});
