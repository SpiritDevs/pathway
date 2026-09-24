// @effect-diagnostics nodeBuiltinImport:off -- the layer tests stage fake binaries in a temp checkout.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import type { CuaDriverHost, CuaDriverHostOptions } from "./CuaDriverHost.ts";
import { DesktopComputer } from "./DesktopComputer.ts";
import { makeFakeHelperSpawner } from "./testing/FakeHelperSpawner.ts";

const hostMock = vi.hoisted(() => ({
  made: 0,
  disposed: 0,
  options: undefined as unknown,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/Applications/Pathway.app/Contents/MacOS/Pathway",
    getAppMetrics: () => [],
  },
  shell: { openExternal: () => Promise.resolve() },
}));

// The host itself is covered by the CuaDriverHost suites; here it only has to
// fail to bind, the way a mkdtemp, marker or EADDRINUSE failure would.
vi.mock("./CuaDriverHost.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CuaDriverHost.ts")>();
  const { Effect } = await import("effect");
  return {
    ...actual,
    sweepOrphanedCuaDrivers: () => Effect.void,
    makeCuaDriverHost: (options: unknown) =>
      Effect.sync(() => {
        hostMock.made += 1;
        hostMock.options = options;
        return {
          listen: Effect.fail(new actual.CuaHostError({ message: "listen EADDRINUSE" })),
          inputMonitorStateChanged: () => Effect.void,
          dispose: Effect.sync(() => {
            hostMock.disposed += 1;
          }),
        } as unknown as CuaDriverHost;
      }),
  };
});

const { computerUseEnabled, layer, makeRendererPush } = await import("./DesktopComputerHost.ts");

const enabledFor = (platform: NodeJS.Platform, env: Record<string, string>) =>
  computerUseEnabled.pipe(
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

describe("computerUseEnabled", () => {
  it.effect("stays off unless PATHWAY_COMPUTER_USE opts in", () =>
    Effect.gen(function* () {
      expect(yield* enabledFor("darwin", {})).toBe(false);
      expect(yield* enabledFor("darwin", { PATHWAY_COMPUTER_USE: "0" })).toBe(false);
      expect(yield* enabledFor("darwin", { PATHWAY_COMPUTER_USE: "maybe" })).toBe(false);
      expect(yield* enabledFor("darwin", { PATHWAY_COMPUTER_USE: "1" })).toBe(true);
    }),
  );

  it.effect("stays off outside macOS even when opted in", () =>
    Effect.gen(function* () {
      expect(yield* enabledFor("linux", { PATHWAY_COMPUTER_USE: "1" })).toBe(false);
      expect(yield* enabledFor("win32", { PATHWAY_COMPUTER_USE: "1" })).toBe(false);
    }),
  );
});

describe("DesktopComputerHost.layer", () => {
  /** Builds the layer over a checkout in `rootDir`, with every process spawn faked. */
  const build = (rootDir: string, env: Record<string, string>) =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHelperSpawner;
      const path = yield* Path.Path;
      hostMock.made = 0;
      hostMock.disposed = 0;
      const service = yield* Effect.gen(function* () {
        return yield* DesktopComputer;
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer),
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          path,
          platform: "darwin",
          isDevelopment: true,
          isPackaged: false,
          rootDir,
          stateDir: NodePath.join(rootDir, "state"),
          displayName: "Pathway",
          appUserModelId: "com.spiritdevs.pathway.dev",
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(ElectronApp.ElectronApp, {
          whenReady: Effect.never,
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Effect.provideService(
          ElectronPowerMonitor.ElectronPowerMonitor,
          {} as ElectronPowerMonitor.ElectronPowerMonitor["Service"],
        ),
        Effect.provideService(ElectronWindow.ElectronWindow, {
          main: Effect.succeed(Option.none()),
          reveal: () => Effect.void,
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      );
      return { service, spawned: fake.spawned.length };
    });

  const checkout = Effect.acquireRelease(
    Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-computer-layer-")),
    ),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );

  const stageBinaries = (rootDir: string) =>
    Effect.promise(async () => {
      for (const binary of ["cua-driver", "pathway-helper"]) {
        const directory = NodePath.join(rootDir, "apps/desktop/.electron-runtime", binary);
        await NodeFSP.mkdir(directory, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(directory, binary), "", { mode: 0o755 });
      }
    });

  it.effect("spawns nothing and hands off nothing when PATHWAY_COMPUTER_USE is unset", () =>
    Effect.gen(function* () {
      const rootDir = yield* checkout;
      yield* stageBinaries(rootDir);
      const { service, spawned } = yield* build(rootDir, {});
      expect(Option.isNone(service.handoff)).toBe(true);
      expect(spawned).toBe(0);
      expect(hostMock.made).toBe(0);
      expect(yield* service.getState()).toEqual({
        supported: false,
        status: "unsupported",
        message: "Computer use is not enabled in this desktop build.",
        appDisplayName: "Pathway",
        screenRecordingPermission: "unknown",
        inputMonitoringPermission: "unknown",
      });
      expect(yield* service.openPermissionSettings("accessibility")).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("spawns nothing and hands off nothing when the binaries are missing", () =>
    Effect.gen(function* () {
      const rootDir = yield* checkout;
      const { service, spawned } = yield* build(rootDir, { PATHWAY_COMPUTER_USE: "1" });
      expect(Option.isNone(service.handoff)).toBe(true);
      expect(spawned).toBe(0);
      expect(hostMock.made).toBe(0);
      const state = yield* service.startPermissionSetup(["screenRecording"]);
      expect(state.supported).toBe(false);
      expect(state.status).toBe("unsupported");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("degrades to the inert service when the host socket cannot bind", () =>
    Effect.gen(function* () {
      const rootDir = yield* checkout;
      yield* stageBinaries(rootDir);
      // The stored agent cursor seeds the first driver session.
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(rootDir, "state"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(rootDir, "state", "agent-cursor-colors.json"),
          '{"version":1,"style":{"fill":"#AABBCC"}}',
        );
      });
      const { service } = yield* build(rootDir, { PATHWAY_COMPUTER_USE: "1" });
      const options = hostMock.options as CuaDriverHostOptions;
      expect(options.frameTap).toBeDefined();
      expect(options.cursorStyle?.()).toEqual({ fill: "#aabbcc" });
      expect(Option.isNone(service.handoff)).toBe(true);
      expect(hostMock.made).toBe(1);
      expect(hostMock.disposed).toBeGreaterThanOrEqual(1);
      expect(yield* service.getState()).toMatchObject({
        supported: false,
        status: "unsupported",
        message: "The Computer host could not start.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("makeRendererPush", () => {
  /** A main window whose renderer is mid-reload until `finishLoad` runs. */
  const loadingWindow = () => {
    let loading = true;
    const finish: Array<() => void> = [];
    const sent: Array<[string, unknown]> = [];
    const webContents = {
      isDestroyed: () => false,
      isLoadingMainFrame: () => loading,
      send: (channel: string, payload: unknown) => sent.push([channel, payload]),
      once: (event: string, listener: () => void) => {
        if (event === "did-finish-load") finish.push(listener);
      },
    };
    const window = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;
    const finishLoad = () => {
      loading = false;
      for (const listener of finish.splice(0)) listener();
    };
    return { window, sent, finishLoad };
  };

  it.effect("holds the last setup error raised during a reload until the renderer loads", () =>
    Effect.gen(function* () {
      const main = loadingWindow();
      const renderer = makeRendererPush(Effect.succeed(Option.some(main.window)));
      yield* renderer.pushLatest("desktop:computer-error", { message: "first" });
      yield* renderer.pushLatest("desktop:computer-error", { message: "second" });
      // Ordinary state pushes are not replayed; the next snapshot supersedes them.
      expect(yield* renderer.push("desktop:computer-state", { status: "ready" })).toBe(false);
      expect(main.sent).toEqual([]);

      main.finishLoad();
      expect(main.sent).toEqual([["desktop:computer-error", { message: "second" }]]);

      yield* renderer.pushLatest("desktop:computer-error", { message: "third" });
      expect(main.sent.at(-1)).toEqual(["desktop:computer-error", { message: "third" }]);
      expect(main.sent).toHaveLength(2);
    }),
  );
});
