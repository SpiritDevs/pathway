import { EventEmitter } from "node:events";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { withFakeDbusTransport } from "./computerPluginTestDoubles.ts";
import { DbusConnectionClosedError } from "./dbusPlumbing.ts";
import { DBUS_INTERFACE, DBUS_OBJECT_PATH, DBUS_SERVICE, type DbusModule } from "./kwinDbus.ts";
import { sessionBusNameHasOwner, sessionBusNamesHaveOwners } from "./sessionBusNames.ts";

type NameHasOwner = (name: string) => Promise<unknown>;

/**
 * The surface of a dbus-next session bus these probes touch: an EventEmitter
 * with `getProxyObject`, whose proxy exposes the bus daemon's interface, and
 * `disconnect`.
 */
function fakeSessionBus(nameHasOwner: NameHasOwner, onDisconnect?: (bus: EventEmitter) => void) {
  const bus = new EventEmitter();
  const asked: string[] = [];
  let sessions = 0;
  let disconnects = 0;
  const getInterface = (name: string) => {
    if (name !== DBUS_INTERFACE) throw new Error(`unexpected interface ${name}`);
    return {
      NameHasOwner: (owner: string) => {
        asked.push(owner);
        return nameHasOwner(owner);
      },
    };
  };
  const connection = Object.assign(bus, {
    getProxyObject: (service: string, path: string) => {
      if (service !== DBUS_SERVICE || path !== DBUS_OBJECT_PATH) {
        throw new Error(`unexpected proxy ${service} ${path}`);
      }
      return Promise.resolve({ getInterface });
    },
    disconnect: () => {
      disconnects += 1;
      onDisconnect?.(bus);
    },
  });
  const dbusModule: DbusModule = {
    sessionBus: () => {
      sessions += 1;
      return connection as never;
    },
  };
  return {
    bus,
    asked,
    sessions: () => sessions,
    disconnects: () => disconnects,
    dbusModule,
  };
}

describe("sessionBusNamesHaveOwners", () => {
  it.effect("asks NameHasOwner once per name on one connection and disconnects it", () =>
    Effect.gen(function* () {
      const owned = new Set(["org.kde.KWin"]);
      const fake = fakeSessionBus((name) => Promise.resolve(owned.has(name)));

      const answers = yield* sessionBusNamesHaveOwners(
        ["org.kde.KWin", "com.spiritdevs.pathway.ComputerUse"],
        { dbusModule: fake.dbusModule },
      );

      expect(answers).toEqual([true, false]);
      expect(fake.sessions()).toBe(1);
      expect(fake.asked).toEqual(["org.kde.KWin", "com.spiritdevs.pathway.ComputerUse"]);
      expect(fake.disconnects()).toBe(1);
    }),
  );

  it.effect("opens no connection for an empty question", () =>
    Effect.gen(function* () {
      const fake = fakeSessionBus(() => Promise.resolve(true));
      expect(yield* sessionBusNamesHaveOwners([], { dbusModule: fake.dbusModule })).toEqual([]);
      expect(fake.sessions()).toBe(0);
    }),
  );

  it.effect("reads only a strict true as owned", () =>
    Effect.gen(function* () {
      const answers = new Map<string, unknown>([
        ["a", true],
        ["b", 1],
        ["c", "true"],
      ]);
      const fake = fakeSessionBus((name) => Promise.resolve(answers.get(name)));
      expect(
        yield* sessionBusNamesHaveOwners(["a", "b", "c"], { dbusModule: fake.dbusModule }),
      ).toEqual([true, false, false]);
    }),
  );

  it.effect("fails with the connection failure when the bus errors mid-operation", () =>
    Effect.gen(function* () {
      const connectionError = new Error("socket hung up");
      const fake = fakeSessionBus(() => {
        // dbus-next reports a dropped connection on the bus object and then
        // fails the pending call; the probe must surface the former.
        fake.bus.emit("error", connectionError);
        return Promise.reject(new Error("call aborted"));
      });

      const error = yield* Effect.flip(
        sessionBusNamesHaveOwners(["org.kde.KWin"], { dbusModule: fake.dbusModule }),
      );
      expect(error).toBeInstanceOf(DbusConnectionClosedError);
      expect(error).toMatchObject({ cause: connectionError });
      expect(fake.disconnects()).toBe(1);
    }),
  );

  it.effect("fails when the bus disconnects underneath the operation", () =>
    Effect.gen(function* () {
      const fake = fakeSessionBus(() => {
        fake.bus.emit("disconnect");
        return Promise.reject(new Error("call aborted"));
      });

      const error = yield* Effect.flip(
        sessionBusNamesHaveOwners(["org.kde.KWin"], { dbusModule: fake.dbusModule }),
      );
      expect(error).toBeInstanceOf(DbusConnectionClosedError);
    }),
  );

  it.effect("fails at once when the bus daemon goes away under a waiting call", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const fake = fakeSessionBus(() => {
        Deferred.doneUnsafe(asked, Effect.void);
        return new Promise(() => undefined);
      });
      const bus = withFakeDbusTransport(fake.bus);
      const probe = yield* Effect.forkChild(
        Effect.flip(sessionBusNamesHaveOwners(["org.kde.KWin"], { dbusModule: fake.dbusModule })),
        { startImmediately: true },
      );
      yield* Deferred.await(asked);

      // dbus-next fails nothing on EOF; the call would otherwise sit out its
      // five-second timeout. The clock does not move here.
      bus.dropTransport();
      expect(yield* Fiber.join(probe)).toBeInstanceOf(DbusConnectionClosedError);
      expect(fake.disconnects()).toBe(1);
    }),
  );

  it.effect("keeps the error listener attached while disconnecting", () =>
    Effect.gen(function* () {
      // A close that lands on a reset socket is reported as an `error` event
      // from inside disconnect(); with no listener that would throw out of the
      // finalizer and, on a real process, be fatal.
      const fake = fakeSessionBus(
        () => Promise.resolve(true),
        (bus) => {
          bus.emit("error", new Error("ECONNRESET"));
        },
      );

      expect(
        yield* sessionBusNamesHaveOwners(["org.kde.KWin"], { dbusModule: fake.dbusModule }),
      ).toEqual([true]);
    }),
  );

  it.effect("keeps the error listener attached after disconnecting", () =>
    Effect.gen(function* () {
      // The socket closes after disconnect() returns, so a reset reported then
      // lands on a bus whose probe is long over; with no listener left, that
      // `error` would be an uncaught exception.
      const fake = fakeSessionBus(() => Promise.resolve(true));
      expect(
        yield* sessionBusNamesHaveOwners(["org.kde.KWin"], { dbusModule: fake.dbusModule }),
      ).toEqual([true]);
      expect(fake.bus.listenerCount("error")).toBeGreaterThan(0);
      expect(() => fake.bus.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    }),
  );
});

describe("sessionBusNameHasOwner", () => {
  it.effect("delegates a single name to the batch probe", () =>
    Effect.gen(function* () {
      const fake = fakeSessionBus((name) => Promise.resolve(name === "org.kde.KWin"));

      expect(yield* sessionBusNameHasOwner("org.kde.KWin", { dbusModule: fake.dbusModule })).toBe(
        true,
      );
      expect(
        yield* sessionBusNameHasOwner("com.spiritdevs.pathway.ComputerUse", {
          dbusModule: fake.dbusModule,
        }),
      ).toBe(false);

      expect(fake.sessions()).toBe(2);
      expect(fake.asked).toEqual(["org.kde.KWin", "com.spiritdevs.pathway.ComputerUse"]);
      expect(fake.disconnects()).toBe(2);
    }),
  );
});
