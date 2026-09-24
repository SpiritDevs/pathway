/**
 * "Is anyone answering to this bus name?" — the cheapest question you can ask a
 * Linux desktop about what it is.
 *
 * Backend selection uses it to decide whether the compositor is KWin, and the
 * plugin backends' probes use it to see whether their service is up. It lives
 * here rather than in any one caller because all of them need the same three
 * properties: a fresh short-lived connection (a probe must not hold a bus
 * connection open for the life of the process), a bounded wait (an unreachable
 * bus must fail rather than hang startup), and a failure rather than a `false`
 * when the bus itself is the problem — "nobody owns that name" and "there is no
 * bus" lead to different messages and different tiers.
 *
 * @module computer/sessionBusNames
 */
import type { MessageBus } from "dbus-next";
import * as Effect from "effect/Effect";

import { ComputerBackendError } from "./computerErrors.ts";
import {
  type DbusConnectionClosedError,
  type DbusConnectionWatch,
  toDbusCallError,
  watchDbusConnection,
  withDbusTimeout,
} from "./dbusPlumbing.ts";
import {
  DBUS_INTERFACE,
  DBUS_OBJECT_PATH,
  DBUS_SERVICE,
  type DbusEffect,
  invokeKWinDbusMethodOn,
  KWIN_DBUS_DEFAULT_TIMEOUT_MS,
  type KWinComputerDbusOptions,
  KWinDbusTimeoutError,
  loadDbusModule,
} from "./kwinDbus.ts";

/** Whether a name is owned on the session bus. Fails if the bus is unreachable. */
export const sessionBusNameHasOwner = (
  name: string,
  options: KWinComputerDbusOptions = {},
): DbusEffect<boolean> =>
  Effect.map(sessionBusNamesHaveOwners([name], options), ([owned]) => owned === true);

/**
 * `NameHasOwner` for several names on ONE throwaway connection, answered in
 * the order asked. A probe that asks two questions must not pay two bus
 * handshakes for them: the availability probe runs on every thread publish.
 */
export const sessionBusNamesHaveOwners = (
  names: readonly string[],
  options: KWinComputerDbusOptions = {},
): DbusEffect<readonly boolean[]> =>
  names.length === 0
    ? Effect.succeed([])
    : withSessionBus(options, (bus, connection) =>
        Effect.gen(function* () {
          const daemon = yield* proxyObject(bus, DBUS_SERVICE, DBUS_OBJECT_PATH);
          const iface = daemon.getInterface(DBUS_INTERFACE);
          const answers: boolean[] = [];
          for (const name of names) {
            const owned = yield* invokeKWinDbusMethodOn(connection, iface, "NameHasOwner", name);
            answers.push(owned === true);
          }
          return answers;
        }),
      );

/** One `org.freedesktop.DBus.Properties.Get`, on a connection that does not outlive it. */
export const readSessionBusProperty = (
  spec: {
    readonly busName: string;
    readonly objectPath: string;
    readonly interfaceName: string;
    readonly propertyName: string;
  },
  options: KWinComputerDbusOptions = {},
): DbusEffect<unknown> =>
  withSessionBus(options, (bus, connection) =>
    Effect.gen(function* () {
      const object = yield* proxyObject(bus, spec.busName, spec.objectPath);
      const properties = object.getInterface("org.freedesktop.DBus.Properties");
      return yield* invokeKWinDbusMethodOn(
        connection,
        properties,
        "Get",
        spec.interfaceName,
        spec.propertyName,
      );
    }),
  );

/**
 * Runs one operation on a throwaway session-bus connection.
 *
 * The watch's `error` listener is the load-bearing part: dbus-next emits
 * connection failures on the bus object itself, and an unhandled `error` event
 * takes the whole process down. A probe that can crash the server the first
 * time it runs on a host with no session bus is worse than no probe. The watch
 * is also what ends the operation when the bus dies under it: dbus-next leaves
 * a call on a dead socket waiting forever, so without it the probe would sit
 * out its whole timeout.
 */
const withSessionBus = <A>(
  options: KWinComputerDbusOptions,
  operation: (bus: MessageBus, connection: DbusConnectionWatch) => DbusEffect<A>,
): DbusEffect<A> =>
  Effect.gen(function* () {
    const dbus = yield* loadDbusModule(options);
    const bus = dbus.sessionBus();
    const connection = watchDbusConnection(bus);
    let dropped: DbusConnectionClosedError | undefined;
    connection.onClosed((error) => {
      dropped = error;
    });
    return yield* connection.guard(operation(bus, connection)).pipe(
      // The bus's own failure is the answer worth reporting: the call it broke
      // only says that it broke.
      Effect.mapError((error) => dropped ?? error),
      // Disconnecting can surface as an `error` event on the bus (ECONNRESET
      // during close is routine), during disconnect() or after it returns,
      // once the socket actually closes. So the watch's handlers are never
      // removed: an `error` on a bare EventEmitter is an uncaught exception,
      // and the released watch ignores whatever arrives. They go with the bus
      // object.
      Effect.ensuring(
        Effect.sync(() => {
          connection.release(
            new ComputerBackendError({ message: "The session-bus probe is over." }),
          );
          bus.disconnect();
        }),
      ),
    );
  });

const proxyObject = (bus: MessageBus, service: string, path: string) =>
  withDbusTimeout(
    Effect.tryPromise({
      try: () => Promise.resolve(bus.getProxyObject(service, path)),
      catch: toDbusCallError,
    }),
    KWIN_DBUS_DEFAULT_TIMEOUT_MS,
    () =>
      new KWinDbusTimeoutError({
        methodName: "getProxyObject",
        timeoutMs: KWIN_DBUS_DEFAULT_TIMEOUT_MS,
      }),
  );
