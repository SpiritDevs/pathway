// @effect-diagnostics nodeBuiltinImport:off -- the host capability is minted from Node's CSPRNG.
import * as NodeCrypto from "node:crypto";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as Electron from "electron";

import { COMPUTER_PERMISSIONS } from "@spiritdevs/shared/computerGrants";
import type { CuaToolResult } from "@spiritdevs/shared/cuaDriverProtocol";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { MODEL_SCREEN_IMAGE_MAX_DIMENSION } from "@spiritdevs/shared/modelImageBudget";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import { macPermissionAppBundle } from "../snapShot/MacPermissionSetup.ts";
import { resolveComputerBinary } from "./ComputerBinaries.ts";
import * as ComputerDesktopLifecycle from "./ComputerDesktopLifecycle.ts";
import * as ComputerHelper from "./ComputerHelper.ts";
import * as ComputerShield from "./ComputerShield.ts";
import { type CuaDriverHost, makeCuaDriverHost, sweepOrphanedCuaDrivers } from "./CuaDriverHost.ts";
import { DesktopComputer, inertDesktopComputer } from "./DesktopComputer.ts";
import * as EscapeKillSwitchMonitor from "./EscapeKillSwitchMonitor.ts";

// Unset or unparseable reads as off.
const flag = (name: string) =>
  Config.boolean(name).pipe(Config.orElse(() => Config.succeed(false)));

/** Computer use runs only on macOS, and only when `PATHWAY_COMPUTER_USE` opts in. */
export const computerUseEnabled = Effect.gen(function* () {
  return (yield* HostProcessPlatform) === "darwin" && (yield* flag("PATHWAY_COMPUTER_USE"));
});

const warn = (message: string, error?: { readonly message: string }) =>
  Effect.logWarning(`[desktop-computer] ${message}${error ? `: ${error.message}` : ""}`);

// Overview screenshots arrive at full Retina size; the model only needs the budget.
const normalizeOverview = (result: CuaToolResult): CuaToolResult => {
  const content = result.content?.map((part) => {
    if (part.type !== "image" || !part.data) return part;
    const native = Electron.nativeImage.createFromBuffer(Buffer.from(part.data, "base64"));
    const size = native.getSize();
    const longEdge = Math.max(size.width, size.height);
    if (longEdge <= MODEL_SCREEN_IMAGE_MAX_DIMENSION) return part;
    const ratio = MODEL_SCREEN_IMAGE_MAX_DIMENSION / longEdge;
    const scaled = native.resize({
      width: Math.round(size.width * ratio),
      height: Math.round(size.height * ratio),
      quality: "best",
    });
    return { ...part, data: scaled.toPNG().toString("base64") };
  });
  return content ? { ...result, content } : result;
};

// Best effort: a setup session that landed every grant quits the Settings it opened.
const quitSystemSettings = Effect.fn("desktop.computer.quitSystemSettings")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* spawner
    .exitCode(
      ChildProcess.make("/usr/bin/osascript", [
        "-e",
        'tell application "System Settings" to quit',
        "-e",
        'tell application "System Preferences" to quit',
      ]),
    )
    .pipe(Effect.ignore);
});

/**
 * Starts the macOS Computer host when `PATHWAY_COMPUTER_USE=1`: the Cua driver
 * host on its socket, with pathway-helper serving permissions, the Escape
 * kill switch and the masked-activation shield. Everything else gets the
 * inert service. Closing the layer scope disposes the host and its helpers.
 */
const make = Effect.gen(function* () {
  if (!(yield* computerUseEnabled)) return inertDesktopComputer;

  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runFork = yield* FiberSet.makeRuntime<never>();

  const driverPath = yield* resolveComputerBinary("cua-driver");
  const helperPath = yield* resolveComputerBinary("pathway-helper");
  const appBundlePath = yield* Effect.try(() =>
    macPermissionAppBundle(Electron.app.getPath("exe")),
  ).pipe(Effect.option);
  if (Option.isNone(driverPath) || Option.isNone(helperPath) || Option.isNone(appBundlePath)) {
    yield* warn(
      "Computer use is enabled but this build lacks cua-driver, pathway-helper or its app bundle",
    );
    return inertDesktopComputer;
  }

  // Set once the host exists; helper callbacks only fire after that.
  let host: CuaDriverHost | undefined;
  let emergencyStopNotice: Effect.Effect<void> = Effect.void;

  const helper = yield* ComputerHelper.make({
    helperPath,
    appBundlePath: appBundlePath.value,
    appDisplayName: environment.displayName,
    // The renderer surfaces for helper state arrive with the Computer UI.
    onState: () => Effect.void,
    onError: (error) => warn("permission setup failed", error),
    openSettingsPane: (pane) =>
      Effect.promise(() =>
        Electron.shell.openExternal(ComputerHelper.helperSettingsPaneUrl(pane)).catch(() => {}),
      ),
    closeSettingsApp: () =>
      quitSystemSettings().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  });

  const escapeMonitor = yield* EscapeKillSwitchMonitor.make({
    helperPath: helperPath.value,
    // Native interruption owns the drain. The backend notice only relays a stop
    // that engaged, and is forked so a slow backend never delays the local one.
    onEscape: () =>
      host
        ? host.emergencyStopInput.pipe(
            Effect.flatMap((stopped) =>
              stopped ? Effect.sync(() => runFork(emergencyStopNotice)) : Effect.void,
            ),
            Effect.asVoid,
          )
        : Effect.void,
    onPhysicalInput: (event) => (host ? Effect.asVoid(host.physicalInput(event)) : Effect.void),
    onStateChange: (state) => host?.inputMonitorStateChanged(state) ?? Effect.void,
    onError: (message) => warn(`Escape monitor: ${message}`),
  });

  const shield = yield* ComputerShield.make({
    helperPath: helperPath.value,
    onError: (error) => warn("computer shield failed", { message: String(error) }),
  });

  yield* sweepOrphanedCuaDrivers();
  const capability = NodeCrypto.randomBytes(32).toString("base64url");
  host = yield* makeCuaDriverHost({
    binaryPath: driverPath.value,
    bundleId: environment.appUserModelId,
    capability,
    setup: helper.startPermissionSetup(COMPUTER_PERMISSIONS).pipe(Effect.asVoid),
    checkPermissions: ({ force }) =>
      Effect.gen(function* () {
        const state = yield* helper.refreshState(COMPUTER_PERMISSIONS, { force });
        if (
          state.status === "error" &&
          (state.accessibilityPermission === "unknown" ||
            state.inputMonitoringPermission === "unknown" ||
            state.screenRecordingPermission === "unknown")
        )
          return yield* Effect.fail({
            message: state.message ?? "The native helper could not verify macOS permissions.",
          });
        // A fresh Input Monitoring grant replaces a listener that was denied it.
        if (
          host &&
          (yield* host.isInputMonitorRequested) &&
          state.inputMonitoringPermission === "granted" &&
          (yield* escapeMonitor.state).error === "input-monitoring-required"
        )
          yield* escapeMonitor.activate(true);
        return {
          accessibility: state.accessibilityPermission === "granted",
          inputMonitoring: state.inputMonitoringPermission === "granted",
          screenRecording: state.screenRecordingPermission === "granted",
        };
      }),
    releaseHeldInput: helper.releaseHeldInput.pipe(
      Effect.flatMap((released) =>
        released
          ? Effect.void
          : Effect.fail({ message: "pathway-helper did not confirm the held-input release." }),
      ),
    ),
    onInputMonitorArmedChange: (armed) => {
      runFork(escapeMonitor.setArmed(armed));
    },
    inputMonitorState: escapeMonitor.state,
    activateInputMonitor: escapeMonitor.activate(),
    shield,
    normalizeOverview,
    // Computer use must never target the app hosting it.
    ownPids: () =>
      new Set([process.pid, ...Electron.app.getAppMetrics().map((metric) => metric.pid)]),
    warmOnFirstTouch: yield* flag("PATHWAY_CUA_WARM_ON_FIRST_TOUCH"),
  });
  const running = host;
  yield* Effect.addFinalizer(() =>
    running.dispose.pipe(Effect.catch((error) => warn("host dispose failed", error))),
  );
  const listening = yield* Effect.result(running.listen);
  // Like a missing binary, a socket that cannot bind leaves the desktop without Computer.
  if (Result.isFailure(listening)) {
    yield* warn("Computer host could not listen", listening.failure);
    yield* running.dispose.pipe(Effect.catch((error) => warn("host dispose failed", error)));
    return inertDesktopComputer;
  }
  const endpoint = listening.success;

  // powerMonitor exists only once Electron is ready.
  yield* electronApp.whenReady.pipe(
    Effect.andThen(
      ComputerDesktopLifecycle.make({
        monitor: powerMonitor,
        host: running,
        onError: (error) => warn("computer input pause failed", error),
      }),
    ),
    Effect.catch((error) => warn("desktop lifecycle unavailable", error)),
    Effect.forkScoped,
  );

  return {
    handoff: Option.some({ endpoint, capability }),
    suspend: running.suspend.pipe(Effect.catch((error) => warn("host suspend failed", error))),
    resume: running.resume,
    setEmergencyStopNotice: (notice) =>
      Effect.sync(() => {
        emergencyStopNotice = notice;
      }),
  };
});

export const layer = Layer.effect(DesktopComputer, make);
