// @effect-diagnostics preferSchemaOverJson:off - the doubles answer with the raw JSON strings the plugin serves.
/**
 * The plugin and bus doubles every compositor-backend suite drives.
 *
 * They are doubles of a *contract*, not of KWin: `KWinComputerPluginApi` and
 * `KWinComputerDbus` are the surface the Pathway plugin serves on both KWin and
 * Hyprland, and the backend engine is the same on both. Keeping one pair here
 * is what stops the Hyprland suite from growing a second copy that drifts away
 * from the interface the first one tracks.
 *
 * Every method answers synchronously, as an Effect, and fails with the typed
 * failure a suite set on the double.
 */
import { EventEmitter } from "node:events";

import type { ComputerWindow } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";

import { DbusCallError } from "./dbusPlumbing.ts";
import type { KWinComputerDbus, KWinComputerPluginApi, KWinDbusFailure } from "./kwinDbus.ts";

export const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

/**
 * A PNG header carrying the requested dimensions. Only the IHDR size fields are
 * read back, which is what the region/scale mapping is derived from.
 */
export function pngOfSize(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG_1X1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** An answer, or the failure a suite set in its place. */
const answer = <A>(failure: KWinDbusFailure | undefined, value: () => A) =>
  failure === undefined ? Effect.sync(value) : Effect.fail(failure);

export class FakePlugin implements KWinComputerPluginApi {
  instanceId = "initial-instance";
  owner = ":1.42";
  /** `null` mirrors a plugin whose shortcut registration failed. */
  releaseShortcut: string | null | undefined;
  keyboardLayout: string | undefined;
  keyboardLayoutName: string | undefined;
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  capture = true;
  captureBytes: Uint8Array = PNG_1X1;
  running = false;
  workspace:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  captureFailure: KWinDbusFailure | undefined;
  releasedByUser = false;
  idleTimeoutMs: number | undefined;
  idleTimeoutFailure: KWinDbusFailure | undefined;
  position: { readonly x: number; readonly y: number } = { x: 0, y: 0 };
  /** Mirrors KWin clamping a pointer move to the nearest output. */
  clampPointer: ((x: number, y: number) => { readonly x: number; readonly y: number }) | undefined;
  windows: readonly ComputerWindow[] = [
    {
      id: "window-1",
      title: "Terminal",
      appName: "org.kde.konsole",
      pid: 123,
      bounds: { x: 956, y: 1519, width: 648, height: 518 },
      focused: true,
      minimized: false,
      visible: true,
    },
  ];

  /**
   * Interface version 2 features to advertise; empty keeps the fake a version
   * 1 plugin, so a suite opts in to the newer methods one feature at a time.
   */
  features: readonly string[] = [];
  healthJson = () =>
    Effect.sync(() =>
      JSON.stringify({
        ...(this.features.length > 0 ? { interfaceVersion: 2, features: this.features } : {}),
        ok: true,
        running: this.running,
        capture: this.capture,
        releasedByUser: this.releasedByUser,
        idleTimeoutMs: this.idleTimeoutMs ?? 300_000,
        kwinVersion: "6.7.3",
        ...(this.releaseShortcut === undefined ? {} : { releaseShortcut: this.releaseShortcut }),
        ...(this.workspace ? { workspaceGeometry: this.workspace } : {}),
      }),
    );
  /** The plugin's human-active introspection, absent until a test sets it. */
  humanState:
    | {
        readonly humanFocusWindowId?: string;
        readonly msSinceHumanInput?: number;
        readonly ownsCompositor?: boolean;
      }
    | undefined;
  /** Which window the plugin says the agent seat is aimed at. */
  targetWindowId: string | null = "window-1";
  stateJson = () =>
    Effect.sync(() =>
      JSON.stringify({
        position: this.position,
        targetWindowId: this.targetWindowId,
        ...(this.keyboardLayout === undefined ? {} : { keyboardLayout: this.keyboardLayout }),
        ...(this.keyboardLayoutName === undefined
          ? {}
          : { keyboardLayoutName: this.keyboardLayoutName }),
        ...this.humanState,
      }),
    );
  windowsJson = () => Effect.sync(() => JSON.stringify(this.windows));
  locked = false;
  windowsStateJson = () =>
    Effect.sync(() => {
      this.calls.push({ method: "windowsStateJson", args: [] });
      return JSON.stringify({
        windows: this.locked ? [] : this.windows,
        targetWindowId: this.locked ? null : this.targetWindowId,
        workspace: this.workspace ?? { x: 0, y: 0, width: 1920, height: 1080 },
        locked: this.locked,
      });
    });
  start = () =>
    Effect.suspend(() => {
      this.calls.push({ method: "start", args: [] });
      if (this.releasedByUser) {
        return Effect.fail(
          dbusError(
            "com.spiritdevs.pathway.ComputerUse.Error.ControlReleased",
            "computer control was released with Meta+Shift+Esc",
          ),
        );
      }
      this.running = true;
      return Effect.succeed(true);
    });
  stop = () =>
    Effect.sync(() => {
      this.running = false;
      this.releasedByUser = false;
      return this.recordResult("stop");
    });
  setIdleTimeout = (milliseconds: number) =>
    Effect.suspend(() => {
      this.calls.push({ method: "setIdleTimeout", args: [milliseconds] });
      return answer(this.idleTimeoutFailure, () => {
        this.idleTimeoutMs = milliseconds;
        return true;
      });
    });
  humanActiveGuardMs: number | undefined;
  humanActiveGuardFailure: KWinDbusFailure | undefined;
  setHumanActiveGuardMs = (milliseconds: number) =>
    Effect.suspend(() => {
      this.calls.push({ method: "setHumanActiveGuardMs", args: [milliseconds] });
      return answer(this.humanActiveGuardFailure, () => {
        this.humanActiveGuardMs = milliseconds;
        return true;
      });
    });
  agentName: string | undefined;
  agentNameFailure: KWinDbusFailure | undefined;
  setAgentName = (name: string) =>
    Effect.suspend(() => {
      this.calls.push({ method: "setAgentName", args: [name] });
      return answer(this.agentNameFailure, () => {
        this.agentName = name;
        return true;
      });
    });
  focusWindow = (windowId: string) => this.recordInput("focusWindow", windowId);
  raiseWindowFailure: KWinDbusFailure | undefined;
  raiseWindow = (windowId: string) =>
    Effect.suspend(() => {
      if (this.raiseWindowFailure) {
        this.calls.push({ method: "raiseWindow", args: [windowId] });
        return Effect.fail(this.raiseWindowFailure);
      }
      return this.recordInput("raiseWindow", windowId);
    });
  clearFocusWindow = () => this.recordInput("clearFocusWindow");
  resetInputDeliveryFailure: KWinDbusFailure | undefined;
  resetInputDelivery = () =>
    Effect.suspend(() => {
      if (this.resetInputDeliveryFailure) {
        this.calls.push({ method: "resetInputDelivery", args: [] });
        return Effect.fail(this.resetInputDeliveryFailure);
      }
      return this.recordInput("resetInputDelivery");
    });
  movePointer = (x: number, y: number) =>
    Effect.suspend(() => {
      if (this.running) this.position = this.clampPointer?.(x, y) ?? { x, y };
      return this.recordInput("movePointer", x, y);
    });
  /** Fails one input method, the way the plugin refuses an unreachable client. */
  inputFailure: { readonly method: string; readonly error: KWinDbusFailure } | undefined;
  button = (code: number, pressed: boolean) => this.recordInput("button", code, pressed);
  axis = (horizontal: number, vertical: number) => this.recordInput("axis", horizontal, vertical);
  key = (code: number, pressed: boolean) => this.recordInput("key", code, pressed);
  /** The stroke index `keys` stops at, mirroring a refusal mid-batch; undefined delivers all. */
  keysStopAt: number | undefined;
  keys = (strokes: readonly (readonly [code: number, pressed: boolean])[]) =>
    Effect.suspend(() => {
      this.calls.push({ method: "keys", args: [strokes] });
      if (this.inputFailure?.method === "keys" && (this.keysStopAt ?? 0) === 0) {
        return Effect.fail(this.inputFailure.error);
      }
      if (!this.running) return Effect.succeed(0);
      return Effect.succeed(Math.min(strokes.length, this.keysStopAt ?? strokes.length));
    });
  captureWindow = (windowId: string, maxDimension: number) =>
    Effect.suspend(() => {
      this.calls.push({ method: "captureWindow", args: [windowId, maxDimension] });
      return answer(this.captureFailure, () => this.capturedBytes());
    });
  captureRegion = (x: number, y: number, width: number, height: number, maxDimension: number) =>
    Effect.suspend(() => {
      this.calls.push({ method: "captureRegion", args: [x, y, width, height, maxDimension] });
      return answer(this.captureFailure, () => this.capturedBytes());
    });

  /** What `waitForSettle` answers: `[settled, elapsedMs]`. */
  settleAnswer: readonly [settled: boolean, elapsedMs: number] = [true, 0];
  waitForSettle = (windowId: string, quietMs: number, timeoutMs: number) =>
    Effect.sync(() => {
      this.calls.push({ method: "waitForSettle", args: [windowId, quietMs, timeoutMs] });
      return this.settleAnswer;
    });
  /** The MIME type `captureWindowEx`/`captureRegionEx` pair with `captureBytes`. */
  captureMime = "image/png";
  captureWindowEx = (windowId: string, maxDimension: number, flags: number) =>
    Effect.suspend(() => {
      this.calls.push({ method: "captureWindowEx", args: [windowId, maxDimension, flags] });
      return answer(this.captureFailure, () => [this.capturedBytes(), this.captureMime]);
    });
  captureRegionEx = (
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension: number,
    flags: number,
  ) =>
    Effect.suspend(() => {
      this.calls.push({
        method: "captureRegionEx",
        args: [x, y, width, height, maxDimension, flags],
      });
      return answer(this.captureFailure, () => [this.capturedBytes(), this.captureMime]);
    });

  private capturedBytes(): Uint8Array {
    return this.capture ? this.captureBytes : Uint8Array.of();
  }

  private recordResult(method: string, ...args: readonly unknown[]): true {
    this.calls.push({ method, args });
    return true;
  }

  /** Mirrors the plugin refusing every input while the session is stopped. */
  private recordInput(method: string, ...args: readonly unknown[]) {
    return Effect.suspend(() => {
      this.calls.push({ method, args });
      if (this.inputFailure?.method === method) return Effect.fail(this.inputFailure.error);
      return Effect.succeed(this.running);
    });
  }
}

export class FakeDbus implements KWinComputerDbus {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  readonly plugin: FakePlugin;
  loaded: readonly string[] = [];
  /**
   * The unique bus name currently owning com.spiritdevs.pathway.ComputerUse,
   * mimicking how every freshly loaded generation registers under a new unique
   * name.
   */
  serviceOwner: string | undefined;
  /**
   * The running compositor instance; left unset, the fake does not answer
   * `compositorInstance` at all, as an adapter that cannot tell.
   */
  compositorInstance?: () => Effect.Effect<string | undefined, KWinDbusFailure>;
  /** Answer to a liveness ping; undefined means the fake offers no ping. */
  pingAnswer: boolean | undefined = true;
  private ownerCounter = 42;
  private disconnectListener: (() => void) | undefined;
  private ownerListener: ((owner: string | undefined) => void) | undefined;

  constructor(plugin = new FakePlugin()) {
    this.plugin = plugin;
  }

  nameOwner = (name: string) =>
    Effect.sync(() => {
      this.calls.push({ method: "GetNameOwner", args: [name] });
      if (this.serviceOwner !== undefined) return this.serviceOwner;
      return this.loaded.some((id) => id.startsWith("PathwayComputerUsePlugin"))
        ? ":1.42"
        : undefined;
    });
  listLoadedPluginIds = () =>
    Effect.sync(() => {
      this.calls.push({ method: "loadedPlugins", args: [] });
      return this.loaded;
    });
  loadPlugin = (pluginId: string) =>
    Effect.sync(() => {
      this.calls.push({ method: "LoadPlugin", args: [pluginId] });
      this.loaded = [pluginId];
      this.plugin.instanceId = `instance-${pluginId}`;
      if (pluginId.startsWith("PathwayComputerUsePlugin")) {
        // A new registration takes a new unique name; that change across the
        // LoadPlugin boundary is exactly what the backend asserts on.
        this.serviceOwner = `:1.${(this.ownerCounter += 1)}`;
      }
      return true;
    });
  unloadPlugin = (pluginId: string) =>
    Effect.sync(() => {
      this.calls.push({ method: "UnloadPlugin", args: [pluginId] });
      const wasLoaded = this.loaded.includes(pluginId);
      this.loaded = this.loaded.filter((id) => id !== pluginId);
      return wasLoaded;
    });
  connectPlugin = (): Effect.Effect<KWinComputerPluginApi, KWinDbusFailure> =>
    Effect.sync(() => {
      this.calls.push({ method: "connectPlugin", args: [] });
      return this.plugin;
    });
  onDisconnect = (listener: () => void) => {
    this.disconnectListener = listener;
    return () => {
      if (this.disconnectListener === listener) this.disconnectListener = undefined;
    };
  };
  pingOwner = (owner: string) =>
    Effect.sync(() => {
      this.calls.push({ method: "Ping", args: [owner] });
      return this.pingAnswer === true;
    });
  onServiceOwnerChanged = (listener: (owner: string | undefined) => void) => {
    this.ownerListener = listener;
    return () => {
      if (this.ownerListener === listener) this.ownerListener = undefined;
    };
  };
  close = () =>
    Effect.sync(() => {
      this.calls.push({ method: "close", args: [] });
    });
  disconnect = () => this.disconnectListener?.();
  /** The bus daemon announcing a new owner for the plugin service. */
  changeServiceOwner = (owner: string | undefined) => this.ownerListener?.(owner);
}

/** A reply the bus reported, named by its D-Bus error name. */
export function dbusError(type: string, message: string): DbusCallError {
  return new DbusCallError({ message, type, text: message });
}

/**
 * The transport under a `dbus-next` bus, as the connection watch sees it: the
 * `_connection` emitter that reports EOF as `end`, and its socket's `close`.
 * `dropTransport` is the bus daemon going away — which dbus-next itself never
 * reports as `disconnect`.
 */
export function withFakeDbusTransport<T extends object>(
  bus: T,
): T & { readonly _connection: EventEmitter; readonly dropTransport: () => void } {
  const stream = new EventEmitter();
  const connection = Object.assign(new EventEmitter(), { stream });
  return Object.assign(bus, {
    _connection: connection,
    dropTransport: () => {
      connection.emit("end");
      stream.emit("close");
    },
  });
}
