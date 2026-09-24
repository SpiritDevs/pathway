import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";

import type { ComputerInputMonitorState } from "./EscapeKillSwitchMonitor.ts";
import * as LinuxEscapeKillSwitchMonitor from "./LinuxEscapeKillSwitchMonitor.ts";
import { type LinuxEscapeSession, linuxEscapeSession } from "./LinuxEscapeKillSwitchMonitor.ts";

const fixture = Effect.fn("fixture")(function* (sessionType: LinuxEscapeSession = "x11") {
  const callbacks = new Map<string, () => void>();
  const register = vi.fn((accelerator: string, callback: () => void) => {
    if (callbacks.has(accelerator)) return false;
    callbacks.set(accelerator, callback);
    return true;
  });
  const unregister = vi.fn((accelerator: string) => {
    callbacks.delete(accelerator);
  });
  const isSuspended = vi.fn(() => false);
  const isRegistered = vi.fn((accelerator: string) => callbacks.has(accelerator));
  const onEscape = vi.fn();
  const onStateChange = vi.fn<(state: ComputerInputMonitorState) => void>();
  const onError = vi.fn<(message: string) => void>();
  const monitor = yield* LinuxEscapeKillSwitchMonitor.make({
    shortcutRegistry: { register, unregister, isRegistered, isSuspended },
    sessionType,
    onEscape: () => Effect.sync(onEscape),
    onStateChange: (state) => Effect.sync(() => onStateChange(state)),
    onError: (message) => Effect.sync(() => onError(message)),
  });
  return {
    monitor,
    callbacks,
    register,
    unregister,
    isSuspended,
    onEscape,
    onStateChange,
    onError,
  };
});

describe("Linux Escape shortcut", () => {
  it.effect("reserves Escape only while armed and ignores a callback delivered after disarm", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const unrelatedShortcut = vi.fn();
      f.callbacks.set("Control+Shift+S", unrelatedShortcut);
      expect(f.register).not.toHaveBeenCalled();
      assert.deepStrictEqual(yield* f.monitor.state, {
        ready: false,
        error: "input_monitor_idle",
      });

      yield* f.monitor.activate;
      yield* f.monitor.activate;
      yield* f.monitor.setArmed(true);
      expect(f.register).toHaveBeenCalledTimes(1);
      assert.deepStrictEqual(yield* f.monitor.state, { ready: true });
      const oldCallback = f.callbacks.get("Escape")!;
      oldCallback();
      expect(f.onEscape).toHaveBeenCalledTimes(1);

      yield* f.monitor.setArmed(false);
      oldCallback();
      assert.deepStrictEqual(yield* f.monitor.state, {
        ready: false,
        error: "input_monitor_idle",
      });
      expect(f.onEscape).toHaveBeenCalledTimes(1);
      expect(f.unregister).toHaveBeenCalledExactlyOnceWith("Escape");
      assert.strictEqual(f.callbacks.get("Control+Shift+S"), unrelatedShortcut);

      yield* f.monitor.activate;
      oldCallback();
      expect(f.onEscape).toHaveBeenCalledTimes(1);
      f.callbacks.get("Escape")!();
      expect(f.onEscape).toHaveBeenCalledTimes(2);
      yield* f.monitor.dispose;
      assert.isFalse(f.callbacks.has("Escape"));
      assert.strictEqual(f.callbacks.get("Control+Shift+S"), unrelatedShortcut);
    }),
  );

  it.effect("never replaces or unregisters another feature's Escape reservation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const existing = vi.fn();
      f.callbacks.set("Escape", existing);
      yield* f.monitor.activate;
      assert.deepStrictEqual(yield* f.monitor.state, {
        ready: false,
        error: "linux_escape_shortcut_conflict",
      });
      expect(f.register).not.toHaveBeenCalled();
      yield* f.monitor.setArmed(false);
      yield* f.monitor.dispose;
      expect(f.unregister).not.toHaveBeenCalled();
      assert.strictEqual(f.callbacks.get("Escape"), existing);
    }),
  );

  for (const session of ["wayland", "unknown"] as const) {
    it.effect(
      `does not confuse an unverified ${session} portal registration with a working kill switch`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(session);
          yield* f.monitor.activate;
          assert.deepStrictEqual(yield* f.monitor.state, {
            ready: false,
            error:
              session === "wayland"
                ? "linux_escape_portal_unverified"
                : "linux_escape_session_unavailable",
          });
          expect(f.register).not.toHaveBeenCalled();
          yield* f.monitor.dispose;
          expect(f.unregister).not.toHaveBeenCalled();
        }),
    );
  }

  it.effect(
    "keeps input closed when the OS refuses registration and permits a later explicit retry",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.register.mockReturnValueOnce(false);
        yield* f.monitor.activate;
        assert.deepStrictEqual(yield* f.monitor.state, {
          ready: false,
          error: "linux_escape_registration_failed",
        });
        expect(f.onStateChange).not.toHaveBeenCalledWith({ ready: true });
        yield* f.monitor.activate;
        assert.deepStrictEqual(yield* f.monitor.state, { ready: true });
        yield* f.monitor.dispose;
      }),
  );

  it.effect("keeps input closed when Electron throws during registration", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.register.mockImplementationOnce(() => {
        throw new Error("app not ready");
      });
      yield* f.monitor.activate;
      assert.deepStrictEqual(yield* f.monitor.state, {
        ready: false,
        error: "linux_escape_registration_failed",
      });
      yield* f.monitor.dispose;
      expect(f.unregister).not.toHaveBeenCalled();
    }),
  );

  it.effect("reports suspension and obtains a fresh registration before resuming", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.monitor.activate;
      const oldCallback = f.callbacks.get("Escape")!;
      f.isSuspended.mockReturnValue(true);
      oldCallback();
      assert.deepStrictEqual(yield* f.monitor.state, {
        ready: false,
        error: "linux_escape_shortcut_suspended",
      });
      expect(f.onEscape).not.toHaveBeenCalled();
      expect(f.onStateChange).toHaveBeenLastCalledWith({
        ready: false,
        error: "linux_escape_shortcut_suspended",
      });
      f.isSuspended.mockReturnValue(false);
      yield* f.monitor.activate;
      expect(f.unregister).toHaveBeenCalledExactlyOnceWith("Escape");
      expect(f.register).toHaveBeenCalledTimes(2);
      assert.deepStrictEqual(yield* f.monitor.state, { ready: true });
      oldCallback();
      expect(f.onEscape).not.toHaveBeenCalled();
      yield* f.monitor.dispose;
    }),
  );

  it.effect("reports a removed shortcut before another input can be admitted", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.monitor.activate;
      f.callbacks.delete("Escape");
      assert.deepStrictEqual(yield* f.monitor.state, {
        ready: false,
        error: "linux_escape_shortcut_lost",
      });
      expect(f.onStateChange).toHaveBeenLastCalledWith({
        ready: false,
        error: "linux_escape_shortcut_lost",
      });
      yield* f.monitor.dispose;
      expect(f.unregister).not.toHaveBeenCalled();
    }),
  );

  it.effect("disposal releases the owned key and permanently rejects later activation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.monitor.activate;
      const callback = f.callbacks.get("Escape")!;
      yield* f.monitor.dispose;
      yield* f.monitor.dispose;
      yield* f.monitor.activate;
      yield* f.monitor.setArmed(true);
      callback();
      assert.deepStrictEqual(yield* f.monitor.state, {
        ready: false,
        error: "input_monitor_stopped",
      });
      expect(f.onEscape).not.toHaveBeenCalled();
      expect(f.register).toHaveBeenCalledTimes(1);
      expect(f.unregister).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("reports a failed release and retries only the owned key during disposal", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.monitor.activate;
      const callback = f.callbacks.get("Escape")!;
      f.unregister.mockImplementationOnce(() => {
        throw new Error("unregister failed");
      });
      yield* f.monitor.setArmed(false);
      callback();
      assert.deepStrictEqual(yield* f.monitor.state, {
        ready: false,
        error: "linux_escape_release_failed",
      });
      expect(f.onEscape).not.toHaveBeenCalled();
      expect(f.onError).toHaveBeenLastCalledWith("The Escape shortcut could not be released.");
      yield* f.monitor.dispose;
      expect(f.unregister).toHaveBeenNthCalledWith(2, "Escape");
      assert.isFalse(f.callbacks.has("Escape"));
    }),
  );

  it.effect("closing the scope releases the owned key", () =>
    Effect.gen(function* () {
      const f = yield* Effect.scoped(Effect.tap(fixture(), (f) => f.monitor.activate));
      assert.isFalse(f.callbacks.has("Escape"));
      expect(f.onStateChange).toHaveBeenLastCalledWith({
        ready: false,
        error: "input_monitor_stopped",
      });
    }),
  );
});

describe("Linux Escape display session", () => {
  it.each([
    ["", { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" }],
    ["auto", { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" }],
    ["x11", { DISPLAY: ":1" }],
  ])("recognizes an existing direct X11 configuration", (ozone, environment) => {
    assert.strictEqual(linuxEscapeSession(ozone, environment), "x11");
  });

  it.each([
    ["wayland", { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" }],
    ["", { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-1" }],
    ["x11", { DISPLAY: ":1", XDG_SESSION_TYPE: "wayland" }],
  ])(
    "does not mistake native Wayland or XWayland for global X11 coverage",
    (ozone, environment) => {
      assert.strictEqual(linuxEscapeSession(ozone, environment), "wayland");
    },
  );

  it.each([
    ["", {}],
    ["", { DISPLAY: ":1" }],
    ["x11", {}],
    ["headless", { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" }],
    ["", { DISPLAY: ":1", XDG_SESSION_TYPE: "tty" }],
  ])("leaves an ambiguous or non-desktop session unavailable", (ozone, environment) => {
    assert.strictEqual(linuxEscapeSession(ozone, environment), "unknown");
  });
});
