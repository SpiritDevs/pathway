import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

describe("DesktopLifecycle", () => {
  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      let windowsDestroyed = false;
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();

      const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
        metadata: Effect.die("unexpected metadata read"),
        name: Effect.succeed("Pathway"),
        whenReady: Effect.void,
        quit: Effect.void,
        exit: () => Effect.void,
        relaunch: () => Effect.void,
        setPath: () => Effect.void,
        setName: () => Effect.void,
        setAboutPanelOptions: () => Effect.void,
        setAppUserModelId: () => Effect.void,
        getAppMetrics: Effect.succeed([]),
        isDefaultProtocolClient: () => Effect.succeed(false),
        setAsDefaultProtocolClient: () => Effect.succeed(true),
        setDesktopName: () => Effect.void,
        appendCommandLineSwitch: () => Effect.void,
        removeCommandLineSwitch: () => Effect.void,
        onBeforeQuitForUpdate: (listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set("before-quit-for-update", listener);
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete("before-quit-for-update");
              }),
          ).pipe(Effect.asVoid),
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
      } satisfies ElectronApp.ElectronApp["Service"]);

      const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
        shouldUseDarkColors: Effect.succeed(false),
        setSource: () => Effect.void,
        onUpdated: () => Effect.void,
      });

      const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
        createMain: Effect.die("unexpected window creation"),
        ensureMain: Effect.die("unexpected window creation"),
        revealOrCreateMain: Effect.die("unexpected window creation"),
        activate: Effect.void,
        createMainIfBackendReady: Effect.void,
        showConnectingSplash: () => Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
        flushMainWindowBounds: Effect.void,
        dispatchMenuAction: () => Effect.void,
        zoomMain: () => Effect.void,
        syncAppearance: Effect.void,
      });

      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(electronThemeLayer),
        Layer.provideMerge(desktopWindowLayer),
        Layer.provideMerge(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            create: () => Effect.die("unexpected BrowserWindow creation"),
            main: Effect.succeed(Option.none()),
            currentMainOrFirst: Effect.succeed(Option.none()),
            focusedMainOrFirst: Effect.succeed(Option.none()),
            setMain: () => Effect.void,
            clearMain: () => Effect.void,
            reveal: () => Effect.void,
            sendAll: () => Effect.void,
            destroyAll: Effect.sync(() => {
              windowsDestroyed = true;
            }),
            syncAllAppearance: () => Effect.void,
          }),
        ),
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();
          yield* Effect.yieldNow;

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );
          assert.isTrue(windowsDestroyed);

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    });
  }
});
