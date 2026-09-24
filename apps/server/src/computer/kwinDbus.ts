/**
 * The session-bus side of a compositor plugin host: KWin's D-Bus plugin
 * manager, the Pathway computer-use plugin proxy on it, and the deadlines and
 * connection watch every call runs under.
 *
 * Every method returns an Effect that fails with a `KWinDbusFailure`: a reply
 * the bus reported (`DbusCallError`), a call that never answered
 * (`KWinDbusTimeoutError`), a connection that dropped under it
 * (`DbusConnectionClosedError`), or a `ComputerBackendError` this side raised
 * — a connection it released on purpose, a reply it could not read. The
 * classifiers in `dbusFailures.ts` read those to decide between a refused call
 * and a lost connection.
 *
 * @module computer/kwinDbus
 */
import type { EventEmitter } from "node:events";

import type { MessageBus, ProxyObject } from "dbus-next";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { ComputerBackendError } from "./computerErrors.ts";
import { COMPUTER_SERVER_OWNER, makeComputerSessionAuth } from "./computerSessionAuth.ts";
import {
  type DbusConnectionClosedError,
  DbusCallError,
  type DbusConnectionWatch,
  toDbusCallError,
  unwrapDbusValue,
  watchDbusConnection,
  withDbusTimeout,
} from "./dbusPlumbing.ts";

export const KWIN_SERVICE = "org.kde.KWin";
export const KWIN_PLUGINS_PATH = "/Plugins";
export const KWIN_PLUGINS_INTERFACE = "org.kde.KWin.Plugins";
export const KWIN_OBJECT_PATH = "/KWin";
export const KWIN_INTERFACE = "org.kde.KWin";
export const DBUS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
export const DBUS_SERVICE = "org.freedesktop.DBus";
export const DBUS_OBJECT_PATH = "/org/freedesktop/DBus";
export const DBUS_INTERFACE = "org.freedesktop.DBus";
export const COMPUTER_SERVICE = "com.spiritdevs.pathway.ComputerUse";
export const COMPUTER_OBJECT_PATH = "/com/spiritdevs/pathway/ComputerUse";
export const COMPUTER_INTERFACE = "com.spiritdevs.pathway.ComputerUse1";
export const KWIN_DBUS_DEFAULT_TIMEOUT_MS = 5_000;
/** The floor for a capture; `captureTimeoutMs` raises it with the pixel count. */
export const KWIN_DBUS_CAPTURE_TIMEOUT_MS = 10_000;
export const KWIN_DBUS_CAPTURE_MAX_TIMEOUT_MS = 60_000;
/** A liveness ping is answered by the peer's event loop, not by any rendering. */
export const KWIN_DBUS_PING_TIMEOUT_MS = 2_000;
const DBUS_PEER_INTERFACE = "org.freedesktop.DBus.Peer";
const DBUS_NAME_POLL_MS = 100;

/**
 * How long a capture may take before it is called lost. Rendering a region and
 * encoding it as PNG scales with its area, and a 4K-plus multi-monitor
 * workspace legitimately takes longer than a single window; one fixed ten
 * second budget was both too short for the former and pointlessly long for a
 * failure on the latter. Roughly two seconds per million source pixels on top
 * of the floor, capped so a nonsense request still fails in bounded time.
 */
export function captureTimeoutMs(pixels: number | undefined): number {
  if (pixels === undefined || !Number.isFinite(pixels) || pixels <= 0) {
    return KWIN_DBUS_CAPTURE_TIMEOUT_MS;
  }
  const scaled = KWIN_DBUS_CAPTURE_TIMEOUT_MS + (pixels / 1_000_000) * 2_000;
  return Math.min(KWIN_DBUS_CAPTURE_MAX_TIMEOUT_MS, Math.ceil(scaled));
}

/**
 * A call that never answered. `methodName` is what lets the backend tell a slow
 * capture (per-call, retryable) from a plugin that has stopped answering at all
 * (probe liveness, then reconnect): the type alone does not decide that.
 */
export class KWinDbusTimeoutError extends Schema.TaggedErrorClass<KWinDbusTimeoutError>()(
  "KWinDbusTimeoutError",
  { methodName: Schema.String, timeoutMs: Schema.Number },
) {
  override get message(): string {
    return `D-Bus call ${this.methodName} timed out after ${this.timeoutMs} ms.`;
  }
}

/** Everything a call through this module can fail with. */
export type KWinDbusFailure =
  | DbusCallError
  | KWinDbusTimeoutError
  | DbusConnectionClosedError
  | ComputerBackendError;

export type DbusEffect<A> = Effect.Effect<A, KWinDbusFailure>;

/**
 * The plugin methods this proxy calls, with the D-Bus signatures the plugin
 * declares for them (`in` is the concatenated argument signature, `out` the
 * reply). Kept as data so a test can hold the TypeScript surface against the
 * plugin's introspection XML: a method renamed or re-typed on one side and not
 * the other otherwise only fails at runtime, inside the compositor.
 */
export const COMPUTER_PLUGIN_METHOD_SIGNATURES: Readonly<
  Record<string, { readonly in: string; readonly out: string }>
> = {
  authenticate: { in: "s", out: "s" },
  healthJson: { in: "", out: "s" },
  stateJson: { in: "", out: "s" },
  windowsJson: { in: "", out: "s" },
  windowsStateJson: { in: "", out: "s" },
  start: { in: "", out: "b" },
  stop: { in: "", out: "b" },
  setIdleTimeout: { in: "u", out: "b" },
  setHumanActiveGuardMs: { in: "u", out: "b" },
  setAgentName: { in: "s", out: "b" },
  focusWindow: { in: "s", out: "b" },
  raiseWindow: { in: "s", out: "b" },
  clearFocusWindow: { in: "", out: "b" },
  resetInputDelivery: { in: "", out: "b" },
  movePointer: { in: "dd", out: "b" },
  button: { in: "ub", out: "b" },
  axis: { in: "dd", out: "b" },
  key: { in: "ub", out: "b" },
  keys: { in: "a(ub)", out: "u" },
  waitForSettle: { in: "suu", out: "bu" },
  captureWindow: { in: "su", out: "ay" },
  captureRegion: { in: "iiuuu", out: "ay" },
  captureWindowEx: { in: "suu", out: "ays" },
  captureRegionEx: { in: "iiuuuu", out: "ays" },
};

/** The plugin clamps a `waitForSettle` timeout to this. */
const SETTLE_MAX_TIMEOUT_MS = 30_000;

/**
 * `flags` for `captureWindowEx`/`captureRegionEx` (feature `captureEx`). Luma
 * outranks JPEG; without either the bytes are a PNG. Unknown bits are ignored.
 */
export const COMPUTER_CAPTURE_FLAGS = {
  /** An observer's frame: not agent activity, so the idle deadline and badge are untouched. */
  passive: 1,
  /** JPEG at quality 85, `image/jpeg`. */
  jpeg: 2,
  /** Raw 8-bit luma, row-major and unpadded: `image/x-luma8; width=<w>; height=<h>`. */
  luma: 4,
} as const;

export interface KWinComputerPluginApi {
  readonly instanceId?: string;
  /** The unique bus name the proxy is pinned to, for liveness pings. */
  readonly owner?: string;
  readonly healthJson: () => DbusEffect<unknown>;
  readonly stateJson: () => DbusEffect<unknown>;
  readonly windowsJson: () => DbusEffect<unknown>;
  /**
   * Interface version 2, feature `windowsStateJson`: `{windows, targetWindowId,
   * workspace, locked}` in one call, answering rather than refusing while
   * locked. Call only when `healthJson().features` lists it.
   */
  readonly windowsStateJson?: () => DbusEffect<unknown>;
  readonly start: () => DbusEffect<unknown>;
  readonly stop: () => DbusEffect<unknown>;
  readonly setIdleTimeout: (milliseconds: number) => DbusEffect<unknown>;
  /**
   * How recently the human's own seat must have been active for the plugin to
   * refuse a mutating action aimed at the window they are focused on. `0`
   * disables the guard.
   */
  readonly setHumanActiveGuardMs: (milliseconds: number) => DbusEffect<unknown>;
  /** Names the thread driving the ghost cursor, for the on-screen badge. */
  readonly setAgentName: (name: string) => DbusEffect<unknown>;
  readonly focusWindow: (windowId: string) => DbusEffect<unknown>;
  readonly raiseWindow: (windowId: string) => DbusEffect<unknown>;
  readonly clearFocusWindow: () => DbusEffect<unknown>;
  /**
   * Hands every shared client object back to the human seat: clears the
   * explicit focus/aim target, drops any cached direct-injection enter
   * bookkeeping, and releases held buttons and keys. Called whenever the
   * desktop lease changes owner.
   */
  readonly resetInputDelivery: () => DbusEffect<unknown>;
  readonly movePointer: (x: number, y: number) => DbusEffect<unknown>;
  readonly button: (code: number, pressed: boolean) => DbusEffect<unknown>;
  /**
   * Scroll distance in logical pixels on each axis, the same unit as pointer
   * coordinates and window bounds — not wheel notches or lines. One unit is one
   * pixel of content, so a wheel notch is on the order of a hundred. The plugin
   * consumes the same unit, and the agent tool surface documents it, so a delta
   * means the same thing at every hop.
   */
  readonly axis: (horizontal: number, vertical: number) => DbusEffect<unknown>;
  readonly key: (code: number, pressed: boolean) => DbusEffect<unknown>;
  /**
   * Interface version 2, feature `keys`: up to 256 `[code, pressed]` strokes in
   * one call, each checked as `key` checks one. Answers how many were
   * delivered; it stops at the first that was not, and a refusal of the first
   * is an error exactly as from `key`.
   */
  readonly keys?: (
    strokes: readonly (readonly [code: number, pressed: boolean])[],
  ) => DbusEffect<unknown>;
  /**
   * Interface version 2, feature `waitForSettle`: answers `[settled,
   * elapsedMs]` once the window (any window for `""`) has committed new
   * content after the agent's last input and then stayed quiet for
   * `quietMs`, or `[false, elapsedMs]` at `timeoutMs` (the plugin clamps it to
   * 30 s), and `[false, 0]` at once with no session running or no such
   * window. The call's own deadline outlasts `timeoutMs`.
   */
  readonly waitForSettle?: (
    windowId: string,
    quietMs: number,
    timeoutMs: number,
  ) => DbusEffect<unknown>;
  /**
   * `pixels` is the source area the caller expects the capture to render, used
   * only to size the call's deadline; it is not sent to the plugin.
   */
  readonly captureWindow: (
    windowId: string,
    maxDimension: number,
    pixels?: number,
  ) => DbusEffect<unknown>;
  readonly captureRegion: (
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension: number,
  ) => DbusEffect<unknown>;
  /**
   * Interface version 2, feature `captureEx`: the captures above with
   * `COMPUTER_CAPTURE_FLAGS`, answering `[bytes, mime]`. Call only when
   * `healthJson().features` lists it.
   */
  readonly captureWindowEx?: (
    windowId: string,
    maxDimension: number,
    flags: number,
    pixels?: number,
  ) => DbusEffect<unknown>;
  readonly captureRegionEx?: (
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension: number,
    flags: number,
  ) => DbusEffect<unknown>;
}

export interface KWinComputerDbus {
  readonly listLoadedPluginIds: () => DbusEffect<readonly string[]>;
  readonly loadPlugin: (pluginId: string) => DbusEffect<boolean>;
  /** `false` only when KWin reports the id was not loaded to begin with. */
  readonly unloadPlugin: (pluginId: string) => DbusEffect<boolean>;
  /**
   * The unique bus name of whoever owns `name`, or `undefined` when nothing
   * does. This is how a well-known name is pinned to the process that answered
   * it *now*: talking to whichever process holds
   * `com.spiritdevs.pathway.ComputerUse` without checking means a stale
   * duplicate instance silently receives every pointer, key, and capture call.
   */
  readonly nameOwner: (name: string) => DbusEffect<string | undefined>;
  readonly connectPlugin: () => DbusEffect<KWinComputerPluginApi>;
  readonly onDisconnect: (listener: () => void) => () => void;
  /**
   * `org.freedesktop.DBus.Peer.Ping` on a unique name: true when the peer's
   * event loop answered in time, false when it did not. A slow reply to a
   * real method is not proof the plugin is gone; this is the cheap question
   * that settles it before a connection is torn down.
   */
  readonly pingOwner?: (owner: string) => Effect.Effect<boolean>;
  /**
   * Fires when the well-known plugin service changes owner — a plugin unload,
   * reload, or compositor restart — with the new unique name, or undefined when
   * the name became ownerless. This is how the backend learns its pinned proxy
   * is a stale generation without waiting for a call to fail.
   */
  readonly onServiceOwnerChanged?: (listener: (owner: string | undefined) => void) => () => void;
  /**
   * The version of the compositor that is running, read off the compositor
   * itself (`supportInformation`). After a package upgrade the binary on disk
   * is newer than this until the next login, and a plugin has to match this
   * one to load today.
   */
  readonly kwinVersion?: () => DbusEffect<string | undefined>;
  /**
   * Which compositor instance is running right now — KWin's unique bus name,
   * the live Hyprland instance — or `undefined` when none is. A plugin gone
   * from an instance that is still the same one was unloaded on purpose, and
   * is not loaded again behind the human's back; one gone with its instance
   * is reloaded into the new one.
   */
  readonly compositorInstance?: () => DbusEffect<string | undefined>;
  readonly close: () => Effect.Effect<void>;
}

/** The slice of `dbus-next` this module uses; tests pass a fake. */
export interface DbusModule {
  readonly sessionBus: (options?: { readonly busAddress?: string }) => MessageBus;
  readonly Message?: new (fields: Record<string, unknown>) => unknown;
}

export interface KWinComputerDbusOptions {
  /**
   * A private bus to use instead of the ambient session bus, as the nested
   * Tier 3 compositor runs on one. Absent, this is the user's own session bus,
   * which is the only bus a real desktop's KWin is reachable on.
   */
  readonly busAddress?: string;
  /** Tests inject a fake here; production loads the real dbus-next. */
  readonly dbusModule?: DbusModule;
  /** Where the session token file goes; `/tmp` in production, where the plugin reads it. */
  readonly authDirectory?: string;
}

/**
 * The plugin answers a repeated `authenticate` from the same peer inside its
 * cooldown with this error rather than a verdict. It is neither a stale
 * generation nor a refusal: wait out the cooldown and ask again.
 */
export const COMPUTER_AUTH_THROTTLED_ERROR = "com.spiritdevs.pathway.ComputerUse.Error.Throttled";
/**
 * `com.spiritdevs.pathway.ComputerUse` answered from a process that is not the
 * one it has to be — on KWin, anything but KWin's own bus connection, which is
 * where the plugin registers it. A server-side verdict, never sent by a plugin.
 */
export const COMPUTER_SERVICE_OWNER_MISMATCH_ERROR =
  "com.spiritdevs.pathway.ComputerUse.Error.ServiceOwnerMismatch";
const AUTH_THROTTLE_RETRY_DELAY_MS = 1_100;
const AUTH_THROTTLE_MAX_ATTEMPTS = 3;

/**
 * Loads `dbus-next` on first use, so a host that never reaches the Linux path
 * never loads it.
 */
const loadDbusModule = (options: { readonly dbusModule?: DbusModule | undefined }) =>
  options.dbusModule !== undefined
    ? Effect.succeed(options.dbusModule)
    : Effect.promise(async () => {
        const loaded = (await import("dbus-next")) as unknown as DbusModule & {
          readonly default?: DbusModule;
        };
        return loaded.default ?? loaded;
      });

const authenticateWithCooldown = (
  plugin: unknown,
  token: string,
  call: DbusInvoke,
  attempt = 1,
): DbusEffect<unknown> =>
  call(plugin, "authenticate", token).pipe(
    Effect.map(unwrapDbusValue),
    Effect.catch((error) =>
      attempt >= AUTH_THROTTLE_MAX_ATTEMPTS ||
      error._tag !== "DbusCallError" ||
      error.type !== COMPUTER_AUTH_THROTTLED_ERROR
        ? Effect.fail(error)
        : Effect.sleep(Duration.millis(AUTH_THROTTLE_RETRY_DELAY_MS)).pipe(
            Effect.andThen(authenticateWithCooldown(plugin, token, call, attempt + 1)),
          ),
    ),
  );

/**
 * The half of a plugin-host connection that is the same for every compositor:
 * the session bus itself and the Pathway plugin proxy on it. The KWin host adds
 * KWin's D-Bus plugin manager on top; the Hyprland host adds `hyprctl`.
 */
export interface ComputerSessionBus {
  /** Resolves a proxy object, with the shared connection-level timeout. */
  readonly getProxyObject: (service: string, path: string) => DbusEffect<ProxyObject>;
  /** The unique bus name owning `name`, or undefined when nobody does. */
  readonly nameOwner: (name: string) => DbusEffect<string | undefined>;
  /**
   * Connects to the Pathway plugin by its owner's *unique* name, never the
   * well-known one; requires the service to be owned right now.
   */
  readonly connectPlugin: () => DbusEffect<KWinComputerPluginApi>;
  readonly onDisconnect: (listener: () => void) => () => void;
  readonly pingOwner: (owner: string) => Effect.Effect<boolean>;
  readonly onServiceOwnerChanged: (listener: (owner: string | undefined) => void) => () => void;
  readonly close: () => Effect.Effect<void>;
}

type SessionBusRequirements = FileSystem.FileSystem | Path.Path;

/**
 * Connect to a session bus, wired for plugin-host use: disconnect fan-out, the
 * Pathway plugin proxy, and idempotent close. The plugin proxy is resolved only
 * after the backend has selected and loaded an installed plugin, because no
 * compositor owns the Pathway service until a plugin has been loaded.
 *
 * The session token lives until `close`, not until some enclosing scope ends:
 * a backend opens and closes connections for as long as it runs.
 */
export const openComputerSessionBus = (
  options: KWinComputerDbusOptions = {},
): Effect.Effect<ComputerSessionBus, KWinDbusFailure, SessionBusRequirements> =>
  Effect.map(openWatchedSessionBus(options), ({ session }) => session);

/**
 * `openComputerSessionBus`, plus the watch on its connection, for a host in
 * this module whose own calls on the bus must fail with it too.
 */
const openWatchedSessionBus = Effect.fn("openWatchedSessionBus")(function* (
  options: KWinComputerDbusOptions,
): Effect.fn.Return<
  { readonly session: ComputerSessionBus; readonly call: DbusInvoke },
  KWinDbusFailure,
  SessionBusRequirements
> {
  const dbus = yield* loadDbusModule(options);
  const bus = options.busAddress
    ? dbus.sessionBus({ busAddress: options.busAddress })
    : dbus.sessionBus();
  let closed = false;
  const disconnectListeners = new Set<() => void>();
  // The watch's listeners stay attached for the life of the bus object,
  // including through `disconnect()`. dbus-next emits a failure on the bus
  // object itself, and a bus with no `error` listener turns that into an
  // uncaught exception that ends the server process. The window this closes is
  // real: a release write from a finalizer after a timed-out call lands on
  // the socket after `close()` has run, and the ECONNRESET it produces arrives
  // after close.
  const connection = watchDbusConnection(bus);
  connection.onClosed(() => {
    for (const listener of disconnectListeners) listener();
  });
  const call: DbusInvoke = (iface, methodName, ...args) =>
    invokeKWinDbusMethodOn(connection, iface, methodName, ...args);
  const proxyObject = (service: string, path: string) =>
    withTimeout(
      connection.guard(
        Effect.tryPromise({
          try: () => bus.getProxyObject(service, path),
          catch: toDbusCallError,
        }),
      ),
      KWIN_DBUS_DEFAULT_TIMEOUT_MS,
      "getProxyObject",
    );
  const authScope = yield* Scope.make();
  const abandon = Effect.suspend(() => {
    connection.release(releasedConnectionError());
    bus.disconnect();
    return Scope.close(authScope, Exit.void);
  });

  const opened = yield* Effect.gen(function* () {
    const busDaemon = yield* proxyObject(DBUS_SERVICE, DBUS_OBJECT_PATH);
    const daemon = busDaemon.getInterface(DBUS_INTERFACE);
    const ownership = unwrapDbusValue(yield* call(daemon, "RequestName", COMPUTER_SERVER_OWNER, 4));
    if (ownership !== 1) {
      return yield* new ComputerBackendError({
        message:
          "Another Pathway server owns this desktop. Stop its computer session before using this server.",
      });
    }
    const busId = String(unwrapDbusValue(yield* call(daemon, "GetId")));
    const authentication = yield* makeComputerSessionAuth(busId, options.authDirectory).pipe(
      Scope.provide(authScope),
      Effect.mapError(
        (error) => new ComputerBackendError({ message: error.message, cause: error }),
      ),
    );
    return { daemon, authentication };
  }).pipe(Effect.onError(() => abandon));
  const { daemon, authentication } = opened;

  const resolveNameOwner = (name: string): DbusEffect<string | undefined> =>
    call(daemon, "GetNameOwner", name).pipe(
      Effect.map((owner) => {
        const unwrapped = unwrapDbusValue(owner);
        return typeof unwrapped === "string" ? unwrapped : undefined;
      }),
      // "Nobody owns it" is an answer, not a failure: the caller is the one
      // deciding whether an owner was required.
      Effect.catch((error) => (isUnownedNameError(error) ? Effect.undefined : Effect.fail(error))),
    );
  const ownerListeners = new Set<(owner: string | undefined) => void>();
  const onNameOwnerChanged = (name: unknown, _old: unknown, next: unknown) => {
    if (name !== COMPUTER_SERVICE) return;
    const owner = typeof next === "string" && next.length > 0 ? next : undefined;
    for (const listener of ownerListeners) listener(owner);
  };
  const daemonEvents = daemon as unknown as Partial<EventEmitter>;
  daemonEvents.on?.("NameOwnerChanged", onNameOwnerChanged);
  const pingOwner = (owner: string): Effect.Effect<boolean> => {
    const Message = dbus.Message;
    if (!Message) return Effect.succeed(true);
    return withTimeout(
      connection.guard(
        Effect.tryPromise({
          try: () =>
            bus.call(
              new Message({
                destination: owner,
                path: COMPUTER_OBJECT_PATH,
                interface: DBUS_PEER_INTERFACE,
                member: "Ping",
              }) as Parameters<MessageBus["call"]>[0],
            ),
          catch: toDbusCallError,
        }),
      ),
      KWIN_DBUS_PING_TIMEOUT_MS,
      "Ping",
    ).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  };
  const session: ComputerSessionBus = {
    getProxyObject: proxyObject,
    nameOwner: resolveNameOwner,
    pingOwner,
    onServiceOwnerChanged: (listener) => {
      ownerListeners.add(listener);
      return () => ownerListeners.delete(listener);
    },
    connectPlugin: () =>
      Effect.gen(function* () {
        // Address the proxy by the owner's *unique* name, not the well-known
        // one. dbus-next routes every later call by the proxy's destination, so
        // a proxy addressed as `com.spiritdevs.pathway.ComputerUse` follows the
        // name to whoever owns it next — a stale generation or a same-session
        // squatter taking the name after the backend's ownership check would
        // silently receive every pointer, key, and capture call. Pinned to the
        // unique name, a replaced owner makes calls fail loudly instead, and
        // the reconnect path re-resolves the fresh owner from scratch.
        const owner = yield* resolveNameOwner(COMPUTER_SERVICE);
        if (owner === undefined) {
          return yield* new ComputerBackendError({
            message: `Nothing on the session bus owns ${COMPUTER_SERVICE}, so the plugin cannot be connected.`,
          });
        }
        const object = yield* proxyObject(owner, COMPUTER_OBJECT_PATH);
        const plugin = object.getInterface(COMPUTER_INTERFACE);
        const instanceId = yield* authenticateWithCooldown(plugin, authentication.token, call);
        if (typeof instanceId !== "string" || instanceId.length === 0) {
          return yield* new ComputerBackendError({
            message: "Computer plugin authentication failed; rebuild the plugin.",
          });
        }
        return { ...makePluginApi(plugin, connection), instanceId, owner };
      }),
    onDisconnect: (listener) => {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    close: () =>
      Effect.suspend(() => {
        if (closed) return Effect.void;
        closed = true;
        // Fan-out stops, the listeners do not: see the note where they attach.
        disconnectListeners.clear();
        ownerListeners.clear();
        daemonEvents.off?.("NameOwnerChanged", onNameOwnerChanged);
        // Settled now, before anything waits: a call still waiting on this
        // connection must not outlive it into whatever connection replaces it.
        connection.release(releasedConnectionError());
        return Scope.close(authScope, Exit.void).pipe(
          Effect.andThen(Effect.sync(() => bus.disconnect())),
        );
      }),
  };
  return { session, call };
});

/**
 * What a call still waiting on a connection this side closed fails with.
 * Retryable, and deliberately not connection-level: the closer is already
 * replacing the connection, and a late failure read as a dropped bus would
 * tear down the replacement too.
 */
function releasedConnectionError(): ComputerBackendError {
  return new ComputerBackendError({
    message: "The D-Bus call was abandoned: Pathway released the connection it was waiting on.",
    retryable: true,
  });
}

/**
 * Connect to a session bus and KWin's plugin manager.
 */
export const createSessionKWinComputerDbus = Effect.fn("createSessionKWinComputerDbus")(function* (
  options: KWinComputerDbusOptions = {},
): Effect.fn.Return<KWinComputerDbus, KWinDbusFailure, SessionBusRequirements> {
  const { session, call } = yield* openWatchedSessionBus(options);
  return yield* Effect.gen(function* () {
    const pluginsObject = yield* session.getProxyObject(KWIN_SERVICE, KWIN_PLUGINS_PATH);
    const plugins = pluginsObject.getInterface(KWIN_PLUGINS_INTERFACE);
    // KWin exposes the loaded plugin list as the LoadedPlugins property (KWin 6
    // has no loadedPlugins method); keep the method as a fallback for variants
    // that only offer it.
    let properties: unknown;
    try {
      properties = pluginsObject.getInterface(DBUS_PROPERTIES_INTERFACE);
    } catch {
      properties = undefined;
    }
    const dbus: KWinComputerDbus = {
      nameOwner: session.nameOwner,
      listLoadedPluginIds: () =>
        (properties
          ? call(properties, "Get", KWIN_PLUGINS_INTERFACE, "LoadedPlugins")
          : call(plugins, "loadedPlugins")
        ).pipe(Effect.flatMap(readStringArray)),
      loadPlugin: (pluginId) =>
        call(plugins, "LoadPlugin", pluginId).pipe(Effect.flatMap(readPluginBoolean)),
      // KWin's UnloadPlugin reply differs by version: older builds answer
      // `b`, newer ones are void. A void reply means the call succeeded, so
      // only an explicit `false` reports "was not loaded".
      unloadPlugin: (pluginId) =>
        call(plugins, "UnloadPlugin", pluginId).pipe(
          Effect.map((result) => readOptionalBoolean(result) ?? true),
        ),
      connectPlugin: () =>
        Effect.gen(function* () {
          // The plugin lives inside KWin and registers the service on KWin's
          // own bus connection, so the service's owner and KWin's are one
          // unique name. Any other owner is a process pretending to be the
          // plugin, and it is never sent the session token.
          const [serviceOwner, kwinOwner] = yield* Effect.all(
            [session.nameOwner(COMPUTER_SERVICE), session.nameOwner(KWIN_SERVICE)],
            { concurrency: 2 },
          );
          if (serviceOwner !== undefined && serviceOwner !== kwinOwner) {
            return yield* new DbusCallError({
              message:
                `${COMPUTER_SERVICE} is owned by ${serviceOwner}, which is not KWin's bus connection ` +
                `(${kwinOwner ?? "KWin has none"}), so it was not trusted with the session.`,
              type: COMPUTER_SERVICE_OWNER_MISMATCH_ERROR,
            });
          }
          return yield* session.connectPlugin();
        }),
      onDisconnect: session.onDisconnect,
      pingOwner: session.pingOwner,
      onServiceOwnerChanged: session.onServiceOwnerChanged,
      kwinVersion: () =>
        Effect.gen(function* () {
          const object = yield* session.getProxyObject(KWIN_SERVICE, KWIN_OBJECT_PATH);
          const info = unwrapDbusValue(
            yield* call(object.getInterface(KWIN_INTERFACE), "supportInformation"),
          );
          return typeof info === "string" ? parseKwinSupportVersion(info) : undefined;
        }),
      // A restarted KWin re-registers under a new unique name on the same bus.
      compositorInstance: () => session.nameOwner(KWIN_SERVICE),
      close: session.close,
    };
    return dbus;
  }).pipe(Effect.onError(() => session.close()));
});

/** The `KWin version: X.Y.Z` line of KWin's support information, if present. */
export function parseKwinSupportVersion(info: string): string | undefined {
  return /^KWin version:\s*(\d+(?:\.\d+)+)/m.exec(info)?.[1];
}

/**
 * Waits for `name` to be owned on a bus, and reports whether it appeared.
 *
 * One connection polls `NameHasOwner` rather than reconnecting per attempt: a
 * connect/disconnect cycle per poll would churn the bus, and a failed connect
 * can emit a late error on a bus nobody is listening to any more. A bus that
 * dies during the wait — the daemon it is waiting on crashed — fails at once
 * with `DbusConnectionClosedError`, not at the end of the timeout.
 */
export const waitForSessionBusName = (options: {
  readonly busAddress: string;
  readonly name: string;
  readonly timeoutMs: number;
  readonly pollMs?: number;
  /** Ends the wait early, for a caller that knows the name will never appear. */
  readonly abort?: () => boolean;
  /** Tests inject a fake here; production loads the real dbus-next. */
  readonly dbusModule?: DbusModule;
}): DbusEffect<boolean> =>
  Effect.gen(function* () {
    const dbus = yield* loadDbusModule(options);
    const bus = dbus.sessionBus({ busAddress: options.busAddress });
    // Never detached: the bus is dropped after this, and a late socket error on
    // a bus with no `error` listener would be an uncaught exception.
    const connection = watchDbusConnection(bus);
    return yield* Effect.gen(function* () {
      const daemon = yield* withTimeout(
        connection.guard(
          Effect.tryPromise({
            try: () => bus.getProxyObject(DBUS_SERVICE, DBUS_OBJECT_PATH),
            catch: toDbusCallError,
          }),
        ),
        KWIN_DBUS_DEFAULT_TIMEOUT_MS,
        "getProxyObject",
      );
      const iface = daemon.getInterface(DBUS_INTERFACE);
      const deadline = (yield* Clock.currentTimeMillis) + options.timeoutMs;
      for (;;) {
        if (options.abort?.() === true) return false;
        const owned = yield* invokeKWinDbusMethodOn(
          connection,
          iface,
          "NameHasOwner",
          options.name,
        );
        if (owned === true) return true;
        if ((yield* Clock.currentTimeMillis) >= deadline) return false;
        yield* connection.guard(Effect.sleep(Duration.millis(options.pollMs ?? DBUS_NAME_POLL_MS)));
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          connection.release(
            new ComputerBackendError({ message: "The bus-name wait is over.", retryable: true }),
          );
          bus.disconnect();
        }),
      ),
    );
  });

function isUnownedNameError(error: KWinDbusFailure): boolean {
  // dbus-next keeps the D-Bus error name in `type`; `message` contains only
  // the human-readable text and need not mention NameHasNoOwner at all.
  if (
    error._tag === "DbusCallError" &&
    (error.type === "org.freedesktop.DBus.Error.NameHasNoOwner" ||
      error.type === "org.freedesktop.DBus.Error.ServiceUnknown")
  ) {
    return true;
  }
  return error.message.includes("NameHasNoOwner") || error.message.includes("ServiceUnknown");
}

function makePluginApi(
  iface: unknown,
  connection: DbusConnectionWatch | undefined,
): KWinComputerPluginApi {
  const invoke: DbusInvoke = (target, methodName, ...args) =>
    invokeKWinDbusMethodOn(connection, target, methodName, ...args);
  const invokeWithTimeout = (
    target: unknown,
    methodName: string,
    timeoutMs: number,
    ...args: readonly unknown[]
  ) => invokeOn(connection, target, methodName, timeoutMs, args);
  return {
    healthJson: () => invoke(iface, "healthJson"),
    stateJson: () => invoke(iface, "stateJson"),
    windowsJson: () => invoke(iface, "windowsJson"),
    windowsStateJson: () => invoke(iface, "windowsStateJson"),
    start: () => invoke(iface, "start"),
    stop: () => invoke(iface, "stop"),
    setIdleTimeout: (milliseconds) => invoke(iface, "setIdleTimeout", milliseconds),
    setHumanActiveGuardMs: (milliseconds) => invoke(iface, "setHumanActiveGuardMs", milliseconds),
    setAgentName: (name) => invoke(iface, "setAgentName", name),
    focusWindow: (windowId) => invoke(iface, "focusWindow", windowId),
    raiseWindow: (windowId) => invoke(iface, "raiseWindow", windowId),
    clearFocusWindow: () => invoke(iface, "clearFocusWindow"),
    resetInputDelivery: () => invoke(iface, "resetInputDelivery"),
    movePointer: (x, y) => invoke(iface, "movePointer", x, y),
    button: (code, pressed) => invoke(iface, "button", code, pressed),
    axis: (horizontal, vertical) => invoke(iface, "axis", horizontal, vertical),
    key: (code, pressed) => invoke(iface, "key", code, pressed),
    keys: (strokes) => invoke(iface, "keys", strokes),
    waitForSettle: (windowId, quietMs, timeoutMs) =>
      invokeWithTimeout(
        iface,
        "waitForSettle",
        Math.min(timeoutMs, SETTLE_MAX_TIMEOUT_MS) + KWIN_DBUS_DEFAULT_TIMEOUT_MS,
        windowId,
        quietMs,
        timeoutMs,
      ),
    captureWindow: (windowId, maxDimension, pixels) =>
      invokeWithTimeout(iface, "captureWindow", captureTimeoutMs(pixels), windowId, maxDimension),
    captureRegion: (x, y, width, height, maxDimension) =>
      invokeWithTimeout(
        iface,
        "captureRegion",
        captureTimeoutMs(width * height),
        x,
        y,
        width,
        height,
        maxDimension,
      ),
    captureWindowEx: (windowId, maxDimension, flags, pixels) =>
      invokeWithTimeout(
        iface,
        "captureWindowEx",
        captureTimeoutMs(pixels),
        windowId,
        maxDimension,
        flags,
      ),
    captureRegionEx: (x, y, width, height, maxDimension, flags) =>
      invokeWithTimeout(
        iface,
        "captureRegionEx",
        captureTimeoutMs(width * height),
        x,
        y,
        width,
        height,
        maxDimension,
        flags,
      ),
  };
}

/** A method call on a proxy interface, with its deadline and, if bound, its connection's. */
type DbusInvoke = (
  iface: unknown,
  methodName: string,
  ...args: readonly unknown[]
) => DbusEffect<unknown>;

export const invokeKWinDbusMethod = (
  iface: unknown,
  methodName: string,
  ...args: readonly unknown[]
): DbusEffect<unknown> => invokeKWinDbusMethodOn(undefined, iface, methodName, ...args);

/**
 * `invokeKWinDbusMethod` on a watched connection: the call also fails the
 * moment that connection ends, rather than at its deadline.
 */
export const invokeKWinDbusMethodOn = (
  connection: DbusConnectionWatch | undefined,
  iface: unknown,
  methodName: string,
  ...args: readonly unknown[]
): DbusEffect<unknown> =>
  invokeOn(
    connection,
    iface,
    methodName,
    isCaptureMethod(methodName) ? KWIN_DBUS_CAPTURE_TIMEOUT_MS : KWIN_DBUS_DEFAULT_TIMEOUT_MS,
    args,
  );

const invokeOn = (
  connection: DbusConnectionWatch | undefined,
  iface: unknown,
  methodName: string,
  timeoutMs: number,
  args: readonly unknown[],
): DbusEffect<unknown> =>
  Effect.suspend(() => {
    if (typeof iface !== "object" || iface === null) {
      return Effect.fail(
        new DbusCallError({ message: `D-Bus interface ${methodName} is unavailable.` }),
      );
    }
    const method = (iface as Record<string, unknown>)[methodName];
    if (typeof method !== "function") {
      return Effect.fail(
        new DbusCallError({ message: `D-Bus method ${methodName} is unavailable.` }),
      );
    }
    const start = Effect.tryPromise({
      try: async (): Promise<unknown> => await Reflect.apply(method, iface, args),
      catch: toDbusCallError,
    });
    return withTimeout(connection ? connection.guard(start) : start, timeoutMs, methodName);
  });

export function isCaptureMethod(methodName: string): boolean {
  return (
    methodName === "captureWindow" ||
    methodName === "captureRegion" ||
    methodName === "captureWindowEx" ||
    methodName === "captureRegionEx"
  );
}

/**
 * A KWin call that never answers fails with `KWinDbusTimeoutError`, which the
 * backend reads to decide between a slow call and a gone plugin, so the type
 * matters as much as the message. Failures KWin does report travel untouched,
 * being already about the call rather than the connection.
 */
const withTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
  methodName: string,
): Effect.Effect<A, E | KWinDbusTimeoutError, R> =>
  withDbusTimeout(effect, timeoutMs, () => new KWinDbusTimeoutError({ methodName, timeoutMs }));

/**
 * A `b` reply, strictly. The plugin answers every input and session method
 * with a boolean, so anything else is a protocol fault worth failing on rather
 * than reading as "refused" — one reader for KWin's plugin manager and for the
 * plugin itself, so the two cannot disagree about what a non-boolean means.
 */
export const readPluginBoolean = (value: unknown): Effect.Effect<boolean, ComputerBackendError> => {
  const unwrapped = unwrapDbusValue(value);
  return typeof unwrapped === "boolean"
    ? Effect.succeed(unwrapped)
    : Effect.fail(
        new ComputerBackendError({ message: "KWin returned a non-boolean plugin result." }),
      );
};

/** `undefined` for the void reply a KWin build without a return value sends. */
export function readOptionalBoolean(value: unknown): boolean | undefined {
  const unwrapped = unwrapDbusValue(value);
  return typeof unwrapped === "boolean" ? unwrapped : undefined;
}

export const readStringArray = (
  value: unknown,
): Effect.Effect<readonly string[], ComputerBackendError> => {
  const unwrapped = unwrapDbusValue(value);
  return Array.isArray(unwrapped) && unwrapped.every((item) => typeof item === "string")
    ? Effect.succeed(unwrapped as readonly string[])
    : Effect.fail(
        new ComputerBackendError({ message: "KWin returned an invalid loaded plugin list." }),
      );
};
