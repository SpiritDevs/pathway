import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopAgentCursorStyle,
  DesktopComputerHelperState,
  DesktopComputerPermissionKind,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import {
  DesktopComputer,
  makeInertDesktopComputer,
  unsupportedComputerHelperState,
} from "../../computer/DesktopComputer.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import {
  getComputerState,
  hideComputerPermissionGuide,
  openComputerPermissionSettings,
  requestComputerPermissions,
  restartComputerApp,
  setComputerCursorStyle,
  showComputerPermissionGuide,
  startComputerPermissionSetup,
} from "./computer.ts";

const trusted = { sender: { id: 7 } };
const untrusted = { sender: { id: 8 } };

const readyState: DesktopComputerHelperState = {
  supported: true,
  status: "ready",
  message: null,
  appDisplayName: "Pathway",
  accessibilityPermission: "granted",
  screenRecordingPermission: "denied",
  inputMonitoringPermission: "granted",
};

interface Calls {
  getState: Array<ReadonlyArray<DesktopComputerPermissionKind> | undefined>;
  requestPermissions: Array<ReadonlyArray<DesktopComputerPermissionKind> | undefined>;
  startPermissionSetup: Array<ReadonlyArray<DesktopComputerPermissionKind>>;
  openPermissionSettings: string[];
  showPermissionGuide: string[];
  hidePermissionGuide: number;
  setCursorStyle: Array<DesktopAgentCursorStyle | null>;
  relaunch: string[];
}

// The lifecycle fake never touches these; relaunch only names them in its type.
const unusedLifecycleRuntimeLayer = Layer.mergeAll(
  Layer.succeed(DesktopShutdown.DesktopShutdown, {} as DesktopShutdown.DesktopShutdown["Service"]),
  Layer.succeed(DesktopState.DesktopState, {} as DesktopState.DesktopState["Service"]),
  Layer.succeed(DesktopWindow.DesktopWindow, {} as DesktopWindow.DesktopWindow["Service"]),
  Layer.succeed(ElectronApp.ElectronApp, {} as ElectronApp.ElectronApp["Service"]),
  Layer.succeed(ElectronTheme.ElectronTheme, {} as ElectronTheme.ElectronTheme["Service"]),
);

const trustedWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
  main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
} as ElectronWindow.ElectronWindow["Service"]);

// Each harness gets its own temp state directory for the cursor preference file.
const stateDirLayer = Layer.effect(
  DesktopEnvironment.DesktopEnvironment,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "pathway-computer-ipc-",
    });
    return { stateDir } as DesktopEnvironment.DesktopEnvironment["Service"];
  }),
);

const makeHarness = () => {
  const calls: Calls = {
    getState: [],
    requestPermissions: [],
    startPermissionSetup: [],
    openPermissionSettings: [],
    showPermissionGuide: [],
    hidePermissionGuide: 0,
    setCursorStyle: [],
    relaunch: [],
  };
  const layer = Layer.mergeAll(
    trustedWindowLayer,
    stateDirLayer,
    unusedLifecycleRuntimeLayer,
    Layer.succeed(DesktopLifecycle.DesktopLifecycle, {
      relaunch: (reason: string) =>
        Effect.sync(() => {
          calls.relaunch.push(reason);
        }),
      register: Effect.void,
    }),
    Layer.succeed(DesktopComputer, {
      ...makeInertDesktopComputer(readyState),
      getState: (permissions) =>
        Effect.sync(() => {
          calls.getState.push(permissions);
          return readyState;
        }),
      requestPermissions: (permissions) =>
        Effect.sync(() => {
          calls.requestPermissions.push(permissions);
          return readyState;
        }),
      startPermissionSetup: (permissions) =>
        Effect.sync(() => {
          calls.startPermissionSetup.push(permissions);
          return readyState;
        }),
      openPermissionSettings: (pane) =>
        Effect.sync(() => {
          calls.openPermissionSettings.push(pane);
          return true;
        }),
      showPermissionGuide: (pane) =>
        Effect.sync(() => {
          calls.showPermissionGuide.push(pane);
        }),
      hidePermissionGuide: Effect.sync(() => {
        calls.hidePermissionGuide += 1;
      }),
      setCursorStyle: (style) =>
        Effect.sync(() => {
          calls.setCursorStyle.push(style);
        }),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return { calls, layer };
};

const withHarness = <A, E, R>(
  body: (harness: { readonly calls: Calls }) => Effect.Effect<A, E, R>,
) => {
  const { calls, layer } = makeHarness();
  return body({ calls }).pipe(Effect.provide(layer));
};

describe("computer IPC", () => {
  it.effect("rejects every method from a renderer other than the main window", () =>
    withHarness(({ calls }) =>
      Effect.gen(function* () {
        const failed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.map(Effect.exit(effect), (exit) => Exit.isFailure(exit));
        const results = [
          yield* failed(getComputerState.handler(undefined, untrusted)),
          yield* failed(requestComputerPermissions.handler(undefined, untrusted)),
          yield* failed(startComputerPermissionSetup.handler(["accessibility"], untrusted)),
          yield* failed(openComputerPermissionSettings.handler("accessibility", untrusted)),
          yield* failed(showComputerPermissionGuide.handler("accessibility", untrusted)),
          yield* failed(hideComputerPermissionGuide.handler(undefined, untrusted)),
          yield* failed(restartComputerApp.handler(undefined, untrusted)),
          yield* failed(setComputerCursorStyle.handler({ fill: "#aabbcc" }, untrusted)),
          yield* failed(getComputerState.handler(undefined)),
        ];
        assert.deepStrictEqual(
          results,
          Array.from({ length: 9 }, () => true),
        );
        assert.deepStrictEqual(calls.getState, []);
        assert.deepStrictEqual(calls.setCursorStyle, []);
        assert.deepStrictEqual(calls.relaunch, []);
      }),
    ),
  );

  it.effect("dedupes grant lists and falls back to the default for invalid ones", () =>
    withHarness(({ calls }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* getComputerState.handler(
            ["accessibility", "screenRecording", "accessibility"],
            trusted,
          ),
          readyState,
        );
        yield* getComputerState.handler(undefined, trusted);
        yield* getComputerState.handler(["camera"], trusted);
        yield* getComputerState.handler([], trusted);
        yield* requestComputerPermissions.handler(
          Array.from({ length: 9 }, () => "accessibility"),
          trusted,
        );
        yield* requestComputerPermissions.handler(["inputMonitoring"], trusted);
        assert.deepStrictEqual(calls.getState, [
          ["accessibility", "screenRecording"],
          undefined,
          undefined,
          undefined,
        ]);
        assert.deepStrictEqual(calls.requestPermissions, [undefined, ["inputMonitoring"]]);
      }),
    ),
  );

  it.effect("requires at least one valid grant to start permission setup", () =>
    withHarness(({ calls }) =>
      Effect.gen(function* () {
        const missing = yield* Effect.exit(
          startComputerPermissionSetup.handler(undefined, trusted),
        );
        assert.isTrue(Exit.isFailure(missing));
        const invalid = yield* Effect.exit(startComputerPermissionSetup.handler(["nope"], trusted));
        assert.isTrue(Exit.isFailure(invalid));
        yield* startComputerPermissionSetup.handler(
          ["screenRecording", "screenRecording"],
          trusted,
        );
        assert.deepStrictEqual(calls.startPermissionSetup, [["screenRecording"]]);
      }),
    ),
  );

  it.effect("ignores unknown settings panes", () =>
    withHarness(({ calls }) =>
      Effect.gen(function* () {
        assert.isFalse(yield* openComputerPermissionSettings.handler("camera", trusted));
        assert.isTrue(yield* openComputerPermissionSettings.handler("screen-recording", trusted));
        yield* showComputerPermissionGuide.handler(42, trusted);
        yield* showComputerPermissionGuide.handler("input-monitoring", trusted);
        yield* hideComputerPermissionGuide.handler(undefined, trusted);
        assert.deepStrictEqual(calls.openPermissionSettings, ["screen-recording"]);
        assert.deepStrictEqual(calls.showPermissionGuide, ["input-monitoring"]);
        assert.strictEqual(calls.hidePermissionGuide, 1);
      }),
    ),
  );

  it.effect("relaunches the app for a Screen Recording grant", () =>
    withHarness(({ calls }) =>
      Effect.gen(function* () {
        yield* restartComputerApp.handler(undefined, trusted);
        assert.deepStrictEqual(calls.relaunch, ["computer-permission-relaunch"]);
      }),
    ),
  );

  it.effect("persists the normalized cursor style before pushing it live", () =>
    withHarness(({ calls }) =>
      Effect.gen(function* () {
        const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filePath = path.join(stateDir, "agent-cursor-colors.json");

        yield* setComputerCursorStyle.handler(
          { fill: " #AABBCC ", rim: "purple", shadow: "#010203" },
          trusted,
        );
        assert.deepStrictEqual(calls.setCursorStyle, [{ fill: "#aabbcc", shadow: "#010203" }]);
        assert.isTrue(yield* fileSystem.exists(filePath));

        // Stock, and anything that normalizes to it, removes the stored override.
        yield* setComputerCursorStyle.handler({ fill: "red" }, trusted);
        assert.deepStrictEqual(calls.setCursorStyle, [
          { fill: "#aabbcc", shadow: "#010203" },
          null,
        ]);
        assert.isFalse(yield* fileSystem.exists(filePath));
      }),
    ),
  );

  it.effect("reports the inert state when no Computer host runs", () =>
    Effect.gen(function* () {
      const state = unsupportedComputerHelperState("unsupported here", "Pathway");
      const result = yield* getComputerState.handler(["accessibility"], trusted).pipe(
        Effect.provideService(DesktopComputer, makeInertDesktopComputer(state)),
        Effect.provideService(ElectronWindow.ElectronWindow, {
          main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
        } as ElectronWindow.ElectronWindow["Service"]),
      );
      assert.deepStrictEqual(result, {
        supported: false,
        status: "unsupported",
        message: "unsupported here",
        appDisplayName: "Pathway",
        screenRecordingPermission: "unknown",
        inputMonitoringPermission: "unknown",
      });
    }),
  );
});
