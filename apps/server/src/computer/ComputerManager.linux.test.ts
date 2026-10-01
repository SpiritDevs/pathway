/**
 * The manager hooks the Linux desktop backends rely on, exercised on the fake:
 * dormant health, the passive status read, refusals the backend declares up
 * front, input-delivery resets, the observed monitor, luma scroll baselines,
 * launch identity, and the observed paste restore.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ComputerAvailability, ComputerWindow } from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import type { ComputerCaptureRequest, ComputerClipboardPasteOffer } from "./ComputerBackend.ts";
import { ComputerDenylistError, type ComputerOperationError } from "./computerErrors.ts";
import {
  COMPUTER_PASTE_CONSUME_TIMEOUT_MS,
  COMPUTER_PASTE_RESTORE_MS,
  ComputerManager,
} from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

const idleHealth = {
  status: "unavailable" as const,
  consecutiveFailures: 0,
  reconnects: 0,
  captureAvailable: false,
};

/** Waits until the manager has handled every backend event emitted before `emit`. */
const afterBackendEvents = (manager: ComputerManager, backend: FakeComputerBackend) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* manager.subscribeEvents;
      // Backend events are handled in order, so the window list this barrier
      // publishes arrives after everything emitted ahead of it.
      backend.emitWindowsChanged(yield* backend.listWindows());
      while ((yield* PubSub.take(events)).type !== "computer.windows-changed");
    }),
  );

it.layer(NodeServices.layer)("ComputerManager Linux desktop hooks", (it) => {
  it.effect("does not call a desktop the backend let go of on purpose disconnected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.listWindows();

        // An idle shutdown or release: the next use brings the desktop back, so
        // the panel keeps the verdict the last availability read gave.
        backend.emitHealthChanged({ ...idleHealth, dormant: true });
        yield* afterBackendEvents(manager, backend);
        expect((yield* manager.getStatus()).availability).toEqual({
          kind: "available",
          backend: "fake",
        });
        expect((yield* manager.getThreadState("thread-dormant")).availability.kind).toBe(
          "available",
        );

        // The same reading without the backend's marker is still a lost desktop,
        // which is what every backend that never sets it (Cua) keeps reporting.
        backend.emitHealthChanged(idleHealth);
        yield* afterBackendEvents(manager, backend);
        expect((yield* manager.getStatus()).availability).toMatchObject({
          kind: "backend-unavailable",
          message: expect.stringContaining("not connected"),
        });
      }),
    ),
  );

  it.effect("keeps a status poll passive on a backend with a dedicated status read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The panel polls every ten seconds. A poll that establishes the desktop
        // is a poll that installs a plugin and boots a compositor nobody asked for.
        let statusReads = 0;
        const backend = Object.assign(new FakeComputerBackend(), {
          statusAvailability: () =>
            Effect.sync((): ComputerAvailability => {
              statusReads += 1;
              return { kind: "available", backend: "fake" };
            }),
        });
        const manager = yield* ComputerManager.make({ backend });

        // Before engagement and after: the passive read answers both, and the
        // establishing read is left to the next real use of the desktop.
        yield* manager.getStatus();
        expect(statusReads).toBe(1);
        yield* manager.listWindows();
        const establishedReads = backend.callsFor("availability").length;
        yield* manager.getStatus();
        expect(statusReads).toBe(2);
        expect(backend.callsFor("availability")).toHaveLength(establishedReads);
      }),
    ),
  );

  it.effect("refuses a text selection the backend cannot make before touching the desktop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = Object.assign(new FakeComputerBackend(), { textRangeSelection: false });
        const manager = yield* ComputerManager.make({ backend });
        const refused = yield* Effect.flip(
          manager.selectText("thread-1", { windowId: "fake-calculator" }, { start: 0, length: 1 }),
        );
        expect(refused).toMatchObject({ rejectedOperation: "selectText" });
        // Nothing was claimed, restacked or aimed for a dispatch that could
        // never have happened.
        for (const method of ["clearFocusWindow", "raiseWindow", "focusWindow", "selectText"]) {
          expect(backend.callsFor(method), method).toHaveLength(0);
        }
      }),
    ),
  );

  it.effect("resets input delivery, not only the aim, when the desktop changes hands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A compositor seat outlives the thread that drove it: a button or
        // modifier the previous owner still held would be held for the next
        // one, and for the human once the lease is released.
        const resets: string[] = [];
        const backend = Object.assign(new FakeComputerBackend(), {
          resetInputDelivery: () => Effect.sync(() => void resets.push("reset")),
        });
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.withAgentActivity("a", manager.pressKey("a", "enter"), undefined, "turn-a");
        expect(resets).toEqual(["reset"]);
        yield* manager.releaseDesktopControl("a", "turn-a");
        expect(resets).toEqual(["reset", "reset"]);
        yield* manager.withAgentActivity("b", manager.pressKey("b", "enter"), undefined, "turn-b");
        expect(resets).toEqual(["reset", "reset", "reset"]);
        // The full reset replaces the aim-only clear on both transitions.
        expect(backend.callsFor("clearFocusWindow")).toHaveLength(0);
      }),
    ),
  );

  it.effect("narrows the untargeted fallback to the backend's observation region", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rightMonitor = { x: 960, y: 0, width: 960, height: 1_080 };
        const backend = Object.assign(new FakeComputerBackend(), {
          defaultObservationRegion: () => Effect.succeed(rightMonitor),
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const vault: ComputerWindow = {
          id: "vault",
          title: "Vault",
          appName: "1Password",
          bounds: { x: 0, y: 0, width: 500, height: 500 },
          focused: false,
          minimized: false,
          visible: true,
        };
        // Nothing holds the agent's focus; the human's denied window sits on
        // the other monitor, which the scoped shot does not photograph.
        backend.emitWindowsChanged([vault]);
        yield* afterBackendEvents(manager, backend);
        const scoped = yield* manager.captureFocusedWindow(1_024, { agentFocusOnly: true });
        expect(scoped.windowId).toBeUndefined();
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "region",
          region: rightMonitor,
          maxDimension: 1_024,
        });

        // On the observed monitor it refuses, exactly as a region capture does.
        backend.emitWindowsChanged([
          { ...vault, bounds: { x: 1_000, y: 0, width: 500, height: 500 } },
        ]);
        yield* afterBackendEvents(manager, backend);
        const refused = yield* Effect.flip(
          manager.captureFocusedWindow(1_024, { agentFocusOnly: true }),
        );
        expect(refused).toBeInstanceOf(ComputerDenylistError);
      }),
    ),
  );

  it.effect(
    "binds a launched app's window by its reported identity when the pid was a wrapper's",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          class WrappedLaunchBackend extends FakeComputerBackend {
            override launchApp(app: string) {
              // `flatpak run` reports its own pid, which never owns a window.
              return Effect.succeed({
                computerId: this.computerId,
                app,
                pid: 999,
                appId: "org.kde.kate",
                window: null,
              });
            }
          }
          const kate: ComputerWindow = {
            id: "kate-1",
            title: "Untitled — Kate",
            appName: "org.kde.kate",
            pid: 4242,
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            focused: false,
            minimized: false,
            visible: true,
          };
          const manager = yield* ComputerManager.make({
            backend: new WrappedLaunchBackend({ windows: [kate] }),
          });
          expect(yield* manager.launchApp("owner", "kate", [], 2_000)).toMatchObject({
            appId: "org.kde.kate",
            window: { id: "kate-1" },
            windowStatus: "ready",
          });
        }),
      ),
  );

  it.effect("keeps the readiness check it started a launch wait with", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const launch = backend.launchApp.bind(backend);
        const listWindows = backend.listWindows.bind(backend);
        const ready: string[] = [];
        let launched = false;
        Object.assign(backend, {
          checkInputReady: (windowId: string) => Effect.sync(() => void ready.push(windowId)),
          // The window is not there yet when the launch returns.
          launchApp: (app: string, args: readonly string[]) =>
            Effect.map(launch(app, args), ({ window, ...result }) => {
              launched = true;
              return { ...result, ...(window?.pid !== undefined ? { pid: window.pid } : {}) };
            }),
          // The member goes away between the launch and the wait's first poll,
          // as it does when the slot's occupant changes.
          listWindows: () =>
            Effect.suspend(() => {
              if (launched) Object.assign(backend, { checkInputReady: undefined });
              return listWindows();
            }),
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const result = yield* manager.launchApp("thread-1", "Editor", [], 1_000);
        expect(result.windowStatus).toBe("ready");
        expect(ready).toHaveLength(1);
      }),
    ),
  );
});

/** A backend that can hand back raw luma for a capture nobody looks at. */
class LumaCaptureBackend extends FakeComputerBackend {
  lumaCaptures = 0;
  malformed = false;
  captureLuma(request: ComputerCaptureRequest) {
    // Same geometry an ordinary capture of this request reports.
    const capture = super.captureScreenshot(request);
    return Effect.map(capture, (shot) => {
      this.lumaCaptures += 1;
      const pixels = shot.width * shot.height;
      return {
        width: shot.width,
        height: shot.height,
        data: new Uint8Array(this.malformed ? pixels - 1 : pixels),
        scale: shot.scale ?? 1,
      };
    });
  }
}

const scrollMeasurementKinds = (backend: FakeComputerBackend) =>
  Effect.gen(function* () {
    const kinds: string[] = [];
    const manager = yield* ComputerManager.make({
      backend,
      actionSettleMs: 0,
      measureScrollTravel: (before, after) =>
        Effect.sync(() => {
          kinds.push(`${before.kind}->${after.kind}`);
          return 40;
        }),
    });
    backend.queueScreenshots(Array.from({ length: 12 }, (_unused, index) => `capture-${index}`));
    return { manager, kinds };
  });

it.layer(NodeServices.layer)("ComputerManager luma scroll baseline", (it) => {
  it.effect("measures a scroll from a luma baseline when the backend can capture one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new LumaCaptureBackend();
        const { manager, kinds } = yield* scrollMeasurementKinds(backend);
        const scrolled = yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 40, {
          observe: true,
        });
        expect(backend.lumaCaptures).toBe(1);
        // The baseline is luma; the capture after the scroll is still a PNG,
        // because it is the observation the caller is handed.
        expect(kinds).toEqual(["luma->png"]);
        expect(scrolled.result.scroll?.traveledY).toBe(40);
        expect(scrolled.observation !== undefined && "screenshot" in scrolled.observation).toBe(
          true,
        );
      }),
    ),
  );

  it.effect("keeps the PNG baseline on a backend without luma capture, or a malformed one", () =>
    Effect.gen(function* () {
      for (const backend of [
        new FakeComputerBackend(),
        Object.assign(new LumaCaptureBackend(), { malformed: true }),
      ]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { manager, kinds } = yield* scrollMeasurementKinds(backend);
            yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 40, {
              observe: true,
            });
            expect(kinds).toEqual(["png->png"]);
          }),
        );
      }
    }),
  );
});

it.layer(NodeServices.layer)("paste clipboard restore", (it) => {
  /** Records when the human's text went back, on the test clock. */
  class RestoreTimingBackend extends FakeComputerBackend {
    restoredAt: number | undefined;
    readonly shortcutSent = Deferred.makeUnsafe<number>();
    override writeClipboard(text: string) {
      const write = super.writeClipboard(text);
      if (text !== "human text" || !Deferred.isDoneUnsafe(this.shortcutSent)) return write;
      return Effect.andThen(
        Effect.tap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() => {
            this.restoredAt ??= now;
          }),
        ),
        write,
      );
    }
    override hotkey(keys: readonly string[]) {
      return Effect.tap(super.hotkey(keys), () =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => Deferred.succeed(this.shortcutSent, now)),
      );
    }
  }

  /** A backend whose clipboard can serve one paste and report when it did. */
  class PasteOnceBackend extends RestoreTimingBackend {
    readonly consumed = Deferred.makeUnsafe<void, ComputerOperationError>();
    writeClipboardForPaste(text: string): Effect.Effect<ComputerClipboardPasteOffer> {
      return Effect.as(Effect.orDie(this.writeClipboard(text)), { consumed: this.consumed });
    }
  }

  const consume = (backend: PasteOnceBackend) => Deferred.succeed(backend.consumed, undefined);

  /**
   * Pastes over the human's clipboard and hands back the running paste and
   * the moment its shortcut went out; the test then moves the clock.
   */
  const startPaste = (backend: RestoreTimingBackend) =>
    Effect.gen(function* () {
      yield* backend.writeClipboard("human text");
      const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
      const pasting = yield* manager
        .paste("thread-1", "agent text")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const shortcutAt = yield* Deferred.await(backend.shortcutSent);
      /** Moves the clock `ms` past the shortcut and reports whether the restore ran. */
      const at = (ms: number) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(shortcutAt + ms - (yield* Clock.currentTimeMillis));
          return backend.restoredAt !== undefined;
        });
      const finish = Effect.gen(function* () {
        expect(yield* Fiber.join(pasting)).toMatchObject({ clipboardRestored: true });
        expect(yield* backend.readClipboard()).toBe("human text");
        return backend.restoredAt! - shortcutAt;
      });
      return { at, finish };
    });

  it.effect("keeps the fixed restore wait on a backend that cannot observe the paste", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paste = yield* startPaste(new RestoreTimingBackend());
        expect(yield* paste.at(COMPUTER_PASTE_RESTORE_MS - 1)).toBe(false);
        yield* paste.at(COMPUTER_PASTE_RESTORE_MS);
        expect(yield* paste.finish).toBe(COMPUTER_PASTE_RESTORE_MS);
      }),
    ),
  );

  it.effect("restores only once a paste-once offer reports the payload read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new PasteOnceBackend();
        const paste = yield* startPaste(backend);
        // A slow app: it reads the offer well after the fixed guess would have
        // put the human's text back under it.
        expect(yield* paste.at(600)).toBe(false);
        yield* consume(backend);
        expect(yield* paste.finish).toBe(600);
      }),
    ),
  );

  it.effect("never restores sooner than the fixed settle after the shortcut", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new PasteOnceBackend();
        const paste = yield* startPaste(backend);
        // Read quickly, well inside the settle.
        yield* paste.at(50);
        yield* consume(backend);
        expect(yield* paste.at(COMPUTER_PASTE_RESTORE_MS - 1)).toBe(false);
        yield* paste.at(COMPUTER_PASTE_RESTORE_MS);
        expect(yield* paste.finish).toBe(COMPUTER_PASTE_RESTORE_MS);
      }),
    ),
  );

  it.effect(
    "takes an offer read before the shortcut for a clipboard watcher's, not the paste",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Klipper or a `wl-paste --watch` history daemon reads every new
          // selection at once; restoring on that read would put the human's text
          // back before the target ever saw the paste.
          const backend = new PasteOnceBackend();
          yield* consume(backend);
          const paste = yield* startPaste(backend);
          expect(yield* paste.at(COMPUTER_PASTE_CONSUME_TIMEOUT_MS - 1)).toBe(false);
          yield* paste.at(COMPUTER_PASTE_CONSUME_TIMEOUT_MS);
          expect(yield* paste.finish).toBe(COMPUTER_PASTE_CONSUME_TIMEOUT_MS);
        }),
      ),
  );

  it.effect("restores at the bound when a paste-once offer is never read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paste = yield* startPaste(new PasteOnceBackend());
        expect(yield* paste.at(COMPUTER_PASTE_CONSUME_TIMEOUT_MS - 1)).toBe(false);
        yield* paste.at(COMPUTER_PASTE_CONSUME_TIMEOUT_MS);
        expect(yield* paste.finish).toBe(COMPUTER_PASTE_CONSUME_TIMEOUT_MS);
      }),
    ),
  );
});
