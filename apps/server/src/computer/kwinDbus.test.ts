import { EventEmitter } from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ComputerBackendError } from "./computerErrors.ts";
import { withFakeDbusTransport } from "./computerPluginTestDoubles.ts";
import { isConnectionLevelFailure } from "./dbusFailures.ts";
import { DbusCallError, DbusConnectionClosedError } from "./dbusPlumbing.ts";
import {
  captureTimeoutMs,
  COMPUTER_AUTH_THROTTLED_ERROR,
  COMPUTER_OBJECT_PATH,
  COMPUTER_SERVICE,
  COMPUTER_SERVICE_OWNER_MISMATCH_ERROR,
  createSessionKWinComputerDbus,
  type DbusEffect,
  type DbusModule,
  invokeKWinDbusMethod,
  KWIN_DBUS_CAPTURE_MAX_TIMEOUT_MS,
  KWIN_DBUS_CAPTURE_TIMEOUT_MS,
  KWIN_DBUS_DEFAULT_TIMEOUT_MS,
  KWinDbusTimeoutError,
  parseKwinSupportVersion,
  readStringArray,
  waitForSessionBusName,
} from "./kwinDbus.ts";

/** A D-Bus method that never answers. */
const never = (): Promise<never> => new Promise(() => undefined);

/** The failure of a call whose answer the test does not read. */
const failureOf = <E, R>(call: Effect.Effect<unknown, E, R>) => Effect.flip(Effect.asVoid(call));

/** A dbus-next module whose session bus is `bus`. */
const moduleOf = (bus: object, extra: Partial<DbusModule> = {}): DbusModule => ({
  sessionBus: () => bus as never,
  ...extra,
});

/** A scratch directory for the session token, removed with the test's scope. */
const authDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "pathway-kwin-dbus-" });
});

describe("KWin D-Bus calls", () => {
  it.effect("times out ordinary and capture calls at their separate limits", () =>
    Effect.gen(function* () {
      let ordinarySettled = false;
      const ordinary = yield* Effect.forkChild(
        failureOf(invokeKWinDbusMethod({ stateJson: never }, "stateJson")).pipe(
          Effect.ensuring(Effect.sync(() => (ordinarySettled = true))),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust(KWIN_DBUS_DEFAULT_TIMEOUT_MS - 1);
      expect(ordinarySettled).toBe(false);
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(ordinary)).toBeInstanceOf(KWinDbusTimeoutError);

      let captureSettled = false;
      const capture = yield* Effect.forkChild(
        failureOf(invokeKWinDbusMethod({ captureWindow: never }, "captureWindow")).pipe(
          Effect.ensuring(Effect.sync(() => (captureSettled = true))),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust(KWIN_DBUS_CAPTURE_TIMEOUT_MS - 1);
      expect(captureSettled).toBe(false);
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(capture)).toBeInstanceOf(KWinDbusTimeoutError);
    }),
  );

  it.effect("answers as soon as the call settles", () =>
    Effect.gen(function* () {
      const answer = yield* invokeKWinDbusMethod(
        { stateJson: () => Promise.resolve("ok") },
        "stateJson",
      );
      expect(answer).toBe("ok");
    }),
  );

  it.effect("passes a failure KWin reported through as the call's own", () =>
    Effect.gen(function* () {
      // Only a timeout is connection-level. A call KWin answered with an error
      // says nothing about the connection, so reading it as one would tear
      // down a session over a bad argument.
      const reported = Object.assign(new Error("invalid arguments"), {
        name: "DBusError",
        type: "org.freedesktop.DBus.Error.InvalidArgs",
      });
      const error = yield* failureOf(
        invokeKWinDbusMethod({ focusWindow: () => Promise.reject(reported) }, "focusWindow"),
      );
      expect(error).toBeInstanceOf(DbusCallError);
      expect(error).toMatchObject({
        type: "org.freedesktop.DBus.Error.InvalidArgs",
        cause: reported,
      });
      expect(isConnectionLevelFailure(error)).toBe(false);
    }),
  );

  it.effect("keeps a one-element loaded plugin array as an array", () =>
    Effect.gen(function* () {
      expect(yield* readStringArray(["onlyPlugin"])).toEqual(["onlyPlugin"]);
      expect(yield* readStringArray({ signature: "as", value: ["onlyPlugin"] })).toEqual([
        "onlyPlugin",
      ]);
    }),
  );
});

describe.skipIf(process.platform === "win32")("connectPlugin owner pinning", () => {
  // A proxy addressed by the well-known name follows the name to whoever owns
  // it next, so a squatter or stale generation taking the name after the
  // backend's ownership check would receive every input and capture call.
  // These pin the proxy's destination to the unique name resolved at connect.
  function fakeBus(options: {
    readonly owner?: string;
    readonly kwinOwner?: string;
    readonly methods?: Readonly<Record<string, unknown>>;
  }) {
    const proxied: string[] = [];
    const bus = {
      proxied,
      getProxyObject: (service: string) => {
        proxied.push(service);
        return Promise.resolve({
          getInterface: (): Record<string, unknown> => ({
            GetNameOwner: (name: string) => {
              if (options.owner === undefined) {
                return Promise.reject(
                  Object.assign(new Error("Could not get owner of name: no such name"), {
                    type: "org.freedesktop.DBus.Error.NameHasNoOwner",
                  }),
                );
              }
              // The plugin registers on KWin's own connection: one unique name.
              if (name === COMPUTER_SERVICE) return Promise.resolve(options.owner);
              if (name === "org.kde.KWin")
                return Promise.resolve(options.kwinOwner ?? options.owner);
              return Promise.resolve(":0.0");
            },
            RequestName: async () => 1,
            GetId: async () => `test${process.pid}`,
            authenticate: async () => "test-instance",
            ...options.methods,
          }),
        });
      },
      disconnect: () => undefined,
      on: () => bus,
      off: () => bus,
    };
    return bus;
  }

  it.layer(NodeServices.layer)((it) => {
    it.effect("waits out a throttled authentication instead of treating it as a refusal", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let attempts = 0;
          const bus = fakeBus({
            owner: ":1.42",
            methods: {
              authenticate: async () => {
                attempts += 1;
                if (attempts === 1) {
                  throw Object.assign(new Error("authentication throttled"), {
                    type: COMPUTER_AUTH_THROTTLED_ERROR,
                  });
                }
                return "test-instance";
              },
            },
          });
          const dbus = yield* createSessionKWinComputerDbus({
            dbusModule: moduleOf(bus),
            authDirectory: yield* authDirectory,
          });
          // Besides each call's own deadline, the cooldown is the only sleep on
          // this path: the clock records it and says when it has started, so
          // the test moves time only then.
          const clock = yield* TestClock.testClockWith(Effect.succeed);
          const waits: number[] = [];
          const cooling = yield* Deferred.make<void>();
          const recordingClock: Clock.Clock = {
            ...clock,
            sleep: (duration) =>
              Effect.suspend(() => {
                const millis = Duration.toMillis(duration);
                if (millis !== KWIN_DBUS_DEFAULT_TIMEOUT_MS) {
                  waits.push(millis);
                  Deferred.doneUnsafe(cooling, Effect.void);
                }
                return clock.sleep(duration);
              }),
          };
          const connecting = yield* Effect.forkChild(
            dbus.connectPlugin().pipe(Effect.provideService(Clock.Clock, recordingClock)),
            { startImmediately: true },
          );
          yield* Deferred.await(cooling);
          yield* TestClock.adjust(1_099);
          expect(attempts).toBe(1);
          yield* TestClock.adjust(1);

          const plugin = yield* Fiber.join(connecting);
          expect(plugin.instanceId).toBe("test-instance");
          expect(attempts).toBe(2);
          expect(waits).toEqual([1_100]);
          yield* dbus.close();
        }),
      ),
    );

    it.effect(
      "addresses the plugin proxy by the resolved unique name, not the well-known one",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const bus = fakeBus({ owner: ":1.42" });
            const dbus = yield* createSessionKWinComputerDbus({
              dbusModule: moduleOf(bus),
              authDirectory: yield* authDirectory,
            });
            yield* dbus.connectPlugin();

            expect(bus.proxied.at(-1)).toBe(":1.42");
            expect(bus.proxied).not.toContain(COMPUTER_SERVICE);
            expect(bus.proxied.filter((service) => service === COMPUTER_OBJECT_PATH)).toEqual([]);
            yield* dbus.close();
          }),
        ),
    );

    it.effect("never authenticates to a service owner that is not KWin's own connection", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const bus = fakeBus({ owner: ":1.99", kwinOwner: ":1.42" });
          const dbus = yield* createSessionKWinComputerDbus({
            dbusModule: moduleOf(bus),
            authDirectory: yield* authDirectory,
          });

          const error = yield* Effect.flip(dbus.connectPlugin());
          expect(error).toMatchObject({
            type: COMPUTER_SERVICE_OWNER_MISMATCH_ERROR,
            message: expect.stringContaining("not KWin's bus connection"),
          });
          expect(bus.proxied).not.toContain(":1.99");
          yield* dbus.close();
        }),
      ),
    );

    it.effect(
      "gives waitForSettle its own timeout plus a margin, and the Ex captures a capture's",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const bus = fakeBus({
              owner: ":1.42",
              methods: { waitForSettle: never, captureRegionEx: never, keys: never },
            });
            const dbus = yield* createSessionKWinComputerDbus({
              dbusModule: moduleOf(bus),
              authDirectory: yield* authDirectory,
            });
            const plugin = yield* dbus.connectPlugin();
            const deadlines = new Map<string, number>();
            const startedAt = yield* Clock.currentTimeMillis;
            const watch = (name: string, call: DbusEffect<unknown>) =>
              Effect.forkChild(
                call.pipe(
                  Effect.catch((error) =>
                    Schema.is(KWinDbusTimeoutError)(error)
                      ? Effect.flatMap(Clock.currentTimeMillis, (now) =>
                          Effect.sync(() => deadlines.set(name, now - startedAt)),
                        )
                      : Effect.void,
                  ),
                ),
                { startImmediately: true },
              );
            const fibers = [
              yield* watch("waitForSettle", plugin.waitForSettle!("window", 100, 20_000)),
              // The plugin clamps a wait to 30 s, and so does the deadline.
              yield* watch("longSettle", plugin.waitForSettle!("window", 100, 120_000)),
              yield* watch("captureRegionEx", plugin.captureRegionEx!(0, 0, 100, 100, 1_536, 1)),
              yield* watch("keys", plugin.keys!([[30, true]])),
            ];
            yield* TestClock.adjust(40_000);
            yield* Fiber.joinAll(fibers);
            expect(deadlines.get("keys")).toBe(KWIN_DBUS_DEFAULT_TIMEOUT_MS);
            expect(deadlines.get("captureRegionEx")).toBe(captureTimeoutMs(100 * 100));
            expect(deadlines.get("waitForSettle")).toBe(20_000 + KWIN_DBUS_DEFAULT_TIMEOUT_MS);
            expect(deadlines.get("longSettle")).toBe(30_000 + KWIN_DBUS_DEFAULT_TIMEOUT_MS);
            yield* dbus.close();
          }),
        ),
    );

    it.effect("refuses to connect when nothing owns the service name", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dbus = yield* createSessionKWinComputerDbus({
            dbusModule: moduleOf(fakeBus({})),
            authDirectory: yield* authDirectory,
          });

          const error = yield* Effect.flip(dbus.connectPlugin());
          expect(error.message).toMatch(/Nothing on the session bus owns/);
          yield* dbus.close();
        }),
      ),
    );
  });
});

describe.skipIf(process.platform === "win32")("session bus lifetime", () => {
  /** A bus that is a real emitter, so an unhandled `error` really throws. */
  function emitterBus(options: { readonly owner?: string } = {}) {
    const bus = new EventEmitter() as EventEmitter & {
      readonly daemon: EventEmitter;
      readonly pinged: string[];
      getProxyObject: (service: string) => Promise<unknown>;
      call: (message: unknown) => Promise<unknown>;
      disconnect: () => void;
      disconnected: boolean;
    };
    const daemon = new EventEmitter();
    Object.assign(daemon, {
      // The plugin registers on KWin's own connection, so both names share it.
      GetNameOwner: async (name: string) =>
        (name === COMPUTER_SERVICE || name === "org.kde.KWin") && options.owner
          ? options.owner
          : ":0.0",
      RequestName: async () => 1,
      GetId: async () => `test${process.pid}`,
      authenticate: async () => "test-instance",
    });
    Object.assign(bus, {
      daemon,
      pinged: [] as string[],
      disconnected: false,
      getProxyObject: async () => ({ getInterface: () => daemon }),
      call: async (message: { destination: string }) => {
        bus.pinged.push(message.destination);
        return undefined;
      },
      disconnect: () => {
        bus.disconnected = true;
      },
    });
    return bus;
  }

  class FakeMessage {
    constructor(fields: Record<string, unknown>) {
      Object.assign(this, fields);
    }
  }

  it.layer(NodeServices.layer)((it) => {
    it.effect("survives a bus error that arrives after close", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const bus = emitterBus({ owner: ":1.42" });
          const dbus = yield* createSessionKWinComputerDbus({
            dbusModule: moduleOf(bus),
            authDirectory: yield* authDirectory,
          });
          yield* dbus.close();
          expect(bus.disconnected).toBe(true);
          // A release write from a finalizer can land on the socket after
          // close; dbus-next reports the ECONNRESET on the bus object, and with
          // no listener left it would be an uncaught exception ending the
          // server.
          expect(() => bus.emit("error", new Error("read ECONNRESET"))).not.toThrow();
          expect(() => bus.emit("disconnect")).not.toThrow();
        }),
      ),
    );

    it.effect("stops fanning out disconnects after close but keeps listening", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const bus = emitterBus({ owner: ":1.42" });
          const dbus = yield* createSessionKWinComputerDbus({
            dbusModule: moduleOf(bus),
            authDirectory: yield* authDirectory,
          });
          let disconnected = 0;
          dbus.onDisconnect(() => {
            disconnected += 1;
          });
          bus.emit("error", new Error("first"));
          expect(disconnected).toBe(1);
          yield* dbus.close();
          bus.emit("error", new Error("late"));
          expect(disconnected).toBe(1);
        }),
      ),
    );

    it.effect("announces a new owner of the plugin service and nothing else", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const bus = emitterBus({ owner: ":1.42" });
          const dbus = yield* createSessionKWinComputerDbus({
            dbusModule: moduleOf(bus),
            authDirectory: yield* authDirectory,
          });
          const owners: Array<string | undefined> = [];
          const unsubscribe = dbus.onServiceOwnerChanged!((owner) => owners.push(owner));
          bus.daemon.emit("NameOwnerChanged", "org.kde.KWin", ":1.1", ":1.2");
          bus.daemon.emit("NameOwnerChanged", COMPUTER_SERVICE, ":1.42", ":1.43");
          bus.daemon.emit("NameOwnerChanged", COMPUTER_SERVICE, ":1.43", "");
          expect(owners).toEqual([":1.43", undefined]);
          unsubscribe();
          bus.daemon.emit("NameOwnerChanged", COMPUTER_SERVICE, "", ":1.44");
          expect(owners).toHaveLength(2);
          yield* dbus.close();
        }),
      ),
    );

    it.effect("pings the plugin owner's unique name through the Peer interface", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const bus = emitterBus({ owner: ":1.42" });
          const dbus = yield* createSessionKWinComputerDbus({
            dbusModule: moduleOf(bus, { Message: FakeMessage }),
            authDirectory: yield* authDirectory,
          });
          expect(yield* dbus.pingOwner!(":1.42")).toBe(true);
          expect(bus.pinged).toEqual([":1.42"]);
          bus.call = async () => {
            throw new Error("no reply");
          };
          expect(yield* dbus.pingOwner!(":1.42")).toBe(false);
          yield* dbus.close();
        }),
      ),
    );

    describe("when the bus daemon goes away", () => {
      const connectedOverTransport = Effect.gen(function* () {
        const bus = withFakeDbusTransport(emitterBus({ owner: ":1.42" }));
        let stateJsonCalls = 0;
        Object.assign(bus.daemon, {
          stateJson: () => {
            stateJsonCalls += 1;
            return never();
          },
          healthJson: never,
        });
        const dbus = yield* createSessionKWinComputerDbus({
          dbusModule: moduleOf(bus),
          authDirectory: yield* authDirectory,
        });
        const plugin = yield* dbus.connectPlugin();
        return { bus, dbus, plugin, stateJsonCalls: () => stateJsonCalls };
      });

      it.effect("fails a waiting plugin call at once, as connection-level, and says so once", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { bus, dbus, plugin, stateJsonCalls } = yield* connectedOverTransport;
            let disconnected = 0;
            dbus.onDisconnect(() => {
              disconnected += 1;
            });
            const waiting = yield* Effect.forkChild(failureOf(plugin.healthJson()), {
              startImmediately: true,
            });

            // No clock advances: the call does not sit out its timeout.
            bus.dropTransport();
            const error = yield* Fiber.join(waiting);
            expect(error).toBeInstanceOf(DbusConnectionClosedError);
            expect(isConnectionLevelFailure(error)).toBe(true);
            expect(disconnected).toBe(1);

            // A call made after the drop is never written to the dead socket.
            expect(yield* failureOf(plugin.stateJson())).toBeInstanceOf(DbusConnectionClosedError);
            expect(stateJsonCalls()).toBe(0);
            bus.emit("error", new Error("Tried to write a message to a closed stream"));
            expect(disconnected).toBe(1);
            yield* dbus.close();
          }),
        ),
      );

      it.effect("fails a waiting call on close without calling it a dropped bus", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { bus, dbus, plugin } = yield* connectedOverTransport;
            let disconnected = 0;
            dbus.onDisconnect(() => {
              disconnected += 1;
            });
            const waiting = yield* Effect.forkChild(failureOf(plugin.healthJson()), {
              startImmediately: true,
            });

            yield* dbus.close();
            bus.dropTransport();

            const error = yield* Fiber.join(waiting);
            // The closer is already replacing this connection: a failure read
            // as connection-level would tear down the replacement as well.
            expect(error).toBeInstanceOf(ComputerBackendError);
            expect(error).toMatchObject({ retryable: true });
            expect(isConnectionLevelFailure(error)).toBe(false);
            expect(disconnected).toBe(0);
          }),
        ),
      );
    });

    it.effect("reads the running KWin version out of the compositor's support information", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const bus = emitterBus({ owner: ":1.42" });
          Object.assign(bus.daemon, {
            supportInformation: async () =>
              "KWin Support Information:\n\nVersion\n=======\nKWin version: 6.7.3\nQt Version: 6.9.1\n",
          });
          const dbus = yield* createSessionKWinComputerDbus({
            dbusModule: moduleOf(bus),
            authDirectory: yield* authDirectory,
          });
          expect(yield* dbus.kwinVersion!()).toBe("6.7.3");
          yield* dbus.close();
        }),
      ),
    );
  });
});

describe("capture deadlines", () => {
  it("scales with the source area, between the floor and the ceiling", () => {
    expect(captureTimeoutMs(undefined)).toBe(KWIN_DBUS_CAPTURE_TIMEOUT_MS);
    expect(captureTimeoutMs(0)).toBe(KWIN_DBUS_CAPTURE_TIMEOUT_MS);
    expect(captureTimeoutMs(1_000_000)).toBe(KWIN_DBUS_CAPTURE_TIMEOUT_MS + 2_000);
    expect(captureTimeoutMs(5_120 * 2_880)).toBeGreaterThan(captureTimeoutMs(1_920 * 1_080));
    expect(captureTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(KWIN_DBUS_CAPTURE_MAX_TIMEOUT_MS);
  });

  it("reads the KWin version line and ignores the rest", () => {
    expect(parseKwinSupportVersion("Qt Version: 6.9.1\nKWin version: 6.8.0\n")).toBe("6.8.0");
    expect(parseKwinSupportVersion("nothing here")).toBeUndefined();
  });
});

describe("waiting for a bus name", () => {
  it.effect("fails as soon as the bus dies instead of polling out the timeout", () =>
    Effect.gen(function* () {
      const bus = withFakeDbusTransport(new EventEmitter());
      const polled = yield* Deferred.make<void>();
      let polls = 0;
      let disconnects = 0;
      Object.assign(bus, {
        getProxyObject: async () => ({
          getInterface: () => ({
            NameHasOwner: async () => {
              polls += 1;
              Deferred.doneUnsafe(polled, Effect.void);
              return false;
            },
          }),
        }),
        disconnect: () => {
          disconnects += 1;
        },
      });
      const waiting = yield* Effect.forkChild(
        Effect.flip(
          waitForSessionBusName({
            busAddress: "unix:path=/nonexistent",
            name: "org.kde.KWin",
            timeoutMs: 60_000,
            pollMs: 10_000,
            dbusModule: moduleOf(bus),
          }),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(polled);
      expect(polls).toBe(1);

      // Long before the next poll or the deadline.
      bus.dropTransport();
      expect(yield* Fiber.join(waiting)).toBeInstanceOf(DbusConnectionClosedError);
      expect(polls).toBe(1);
      expect(disconnects).toBe(1);
      // The bus keeps its error listener after the wait: a late socket error
      // on it is not an uncaught exception.
      expect(() => bus.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    }),
  );
});
