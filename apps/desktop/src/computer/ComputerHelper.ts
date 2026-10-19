import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import type {
  ComputerHelperGrants,
  ComputerHelperPermissionState,
} from "@spiritdevs/shared/computerGrants";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";

import { type HelperProcess, spawnHelper } from "./HelperProcess.ts";
import {
  type HelperPermissionGuideState,
  type HelperPermissionKind,
  type HelperSettingsPane,
  type PathwayHelperMessage,
  PathwayHelperMode,
  type PathwayHelperPermissionCommand,
  parsePathwayHelperMessage,
} from "./PathwayHelperProtocol.ts";

// Permission checks share one serialized queue, so a wedged helper is killed
// rather than stalling every queued read behind it.
const PERMISSION_COMMAND_TIMEOUT_MS = 10_000;
// Read-side freshness only: a grant flip surfaces at the next expiry, and
// request/setup paths always bypass it.
const PERMISSION_CACHE_MS = 5_000;
const GUIDE_GRANT_WATCH_INTERVAL_MS = 800;
const GUIDE_GRANT_WATCH_MAX_MS = 10 * 60 * 1000;
const GUIDE_CLOSE_GRACE_MS = 500;

export const COMPUTER_HELPER_MISSING_MESSAGE =
  "The pathway-helper native helper is missing from this desktop build.";
export const COMPUTER_HELPER_UNSUPPORTED_MESSAGE =
  "macOS permission setup is available only in the macOS desktop app.";
const PERMISSION_TIMEOUT_MESSAGE = "Checking macOS permissions timed out. Try Set up again.";

/** `ready` means the last helper command did not fail; the grant fields say what is missing. */
export type ComputerHelperStatus = "unsupported" | "ready" | "error";

/** Explicit setup failures the helper reports before Settings or a coach opens. */
export type ComputerHelperPermissionSetupErrorCode =
  | "permission_setup_bundle_unavailable"
  | "permission_setup_registration_unresolved"
  | "permission_setup_identity_mismatch";

/**
 * The macOS grant snapshot plus helper health. Accessibility is present only
 * once a caller asked about it; the helper reports just the grants it was
 * queried for.
 */
export interface ComputerHelperState extends ComputerHelperGrants {
  readonly supported: boolean;
  readonly status: ComputerHelperStatus;
  readonly message: string | null;
  readonly permissionSetupErrorCode?: ComputerHelperPermissionSetupErrorCode;
  /** Name macOS shows for this build in System Settings permission lists. */
  readonly appDisplayName: string;
}

export interface ComputerHelperErrorEvent {
  readonly code: ComputerHelperPermissionSetupErrorCode;
  readonly message: string;
  readonly capturedAt: string;
}

export interface ComputerHelperOptions {
  /** The resolved `pathway-helper` binary, or none when this build lacks it. */
  readonly helperPath: Option.Option<string>;
  /** The running `.app` bundle, passed to setup commands and the guide. */
  readonly appBundlePath: string;
  readonly appDisplayName: string;
  /** Called with each distinct state; unchanged snapshots are not re-sent. */
  readonly onState: (state: ComputerHelperState) => Effect.Effect<void>;
  readonly onPermissionGuideState?: (state: HelperPermissionGuideState) => Effect.Effect<void>;
  /** A setup failure the user must act on; callers should bring the app forward. */
  readonly onError?: (error: ComputerHelperErrorEvent) => Effect.Effect<void>;
  /** Opens System Settings at a pane. Only setup sessions call it. */
  readonly openSettingsPane?: (pane: HelperSettingsPane) => Effect.Effect<void>;
  /** Quits System Settings after a setup session that opened it lands every grant. */
  readonly closeSettingsApp?: () => Effect.Effect<void>;
}

export interface ComputerHelper {
  readonly getState: Effect.Effect<ComputerHelperState>;
  /** Checks grants without prompting. Recent grants are served from a 5s cache unless forced. */
  readonly refreshState: (
    permissions?: ReadonlyArray<HelperPermissionKind>,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<ComputerHelperState>;
  /** Raises the macOS prompts for these grants. */
  readonly requestPermissions: (
    permissions?: ReadonlyArray<HelperPermissionKind>,
  ) => Effect.Effect<ComputerHelperState>;
  /**
   * Verifies this app's registration, then walks the floating guide through
   * each pane still missing a grant, opening System Settings at that pane. No
   * macOS prompt is raised: a denied prompt cannot be raised again, while the
   * pane's toggle always works. The session closes the Settings it opened once
   * every grant lands.
   */
  readonly startPermissionSetup: (
    permissions: ReadonlyArray<HelperPermissionKind>,
  ) => Effect.Effect<ComputerHelperState>;
  /** Shows the guide for one pane. It never advances and ends any setup session. */
  readonly showPermissionGuide: (pane: HelperSettingsPane) => Effect.Effect<void>;
  readonly hidePermissionGuide: Effect.Effect<void>;
  /**
   * Releases synthetic input the OS may still believe is held after a driver
   * died mid-gesture. True only when the helper confirms the release.
   */
  readonly releaseHeldInput: Effect.Effect<boolean>;
}

const SETTINGS_PANE_ANCHORS: Record<HelperSettingsPane, string> = {
  accessibility: "Privacy_Accessibility",
  "input-monitoring": "Privacy_ListenEvent",
  "screen-recording": "Privacy_ScreenCapture",
};

/** The System Settings URL for a privacy pane, for `openSettingsPane`. */
export const helperSettingsPaneUrl = (pane: HelperSettingsPane) =>
  `x-apple.systempreferences:com.apple.preference.security?${SETTINGS_PANE_ANCHORS[pane]}`;

const KIND_PANES: Record<HelperPermissionKind, HelperSettingsPane> = {
  accessibility: "accessibility",
  inputMonitoring: "input-monitoring",
  screenRecording: "screen-recording",
};

const PANE_KINDS: Record<HelperSettingsPane, HelperPermissionKind> = {
  accessibility: "accessibility",
  "input-monitoring": "inputMonitoring",
  "screen-recording": "screenRecording",
};

// Setup sessions walk panes in this order whatever order callers pass.
const SETUP_ORDER: ReadonlyArray<HelperPermissionKind> = [
  "accessibility",
  "inputMonitoring",
  "screenRecording",
];

// The helper checks this pair when no --permission selector is passed, so
// this set is sent without selectors.
const LEGACY_KINDS: ReadonlyArray<HelperPermissionKind> = ["inputMonitoring", "screenRecording"];

const isLegacySet = (kinds: ReadonlyArray<HelperPermissionKind>) =>
  kinds.length === LEGACY_KINDS.length && LEGACY_KINDS.every((kind) => kinds.includes(kind));

const isSetupFailureCode = (code: string): code is ComputerHelperPermissionSetupErrorCode =>
  code === "permission_setup_bundle_unavailable" ||
  code === "permission_setup_registration_unresolved" ||
  code === "permission_setup_identity_mismatch";

type PermissionsMessage = Extract<PathwayHelperMessage, { type: "permissions" }>;
type ErrorMessage = Extract<PathwayHelperMessage, { type: "error" }>;
type Permission = Extract<ComputerHelperPermissionState, "granted" | "denied" | "unknown">;

interface GuideEntry {
  readonly pane: HelperSettingsPane;
  helper: HelperProcess | undefined;
  lastState: HelperPermissionGuideState | null;
  watch: Fiber.Fiber<void> | undefined;
  watchPending: boolean;
}

/**
 * Runs `pathway-helper` for permission checks, the permission guide and
 * held-input release. Helpers are children of the caller's scope; closing it
 * kills them and stops every timer.
 */
export const make = Effect.fn("desktop.computer.ComputerHelper.make")(function* (
  options: ComputerHelperOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outer = yield* Scope.Scope;
  const supported = (yield* HostProcessPlatform) === "darwin";
  const scope = yield* Scope.fork(outer);

  const onGuideState = options.onPermissionGuideState ?? (() => Effect.void);

  let disposed = false;
  let accessibility: Permission | undefined = undefined;
  let inputMonitoring: Permission = "unknown";
  let screenRecording: Permission = "unknown";
  let status: ComputerHelperStatus = supported ? "ready" : "unsupported";
  let message: string | null = supported ? null : COMPUTER_HELPER_UNSUPPORTED_MESSAGE;
  // An explicit setup failure survives passive refreshes until another
  // explicit attempt or an app restart.
  let setupFailure: { code: ComputerHelperPermissionSetupErrorCode; message: string } | null = null;
  let lastEmitted: ComputerHelperState | null = null;
  const grantCache = new Map<HelperPermissionKind, number>();
  const permissionChecks = new Map<string, Deferred.Deferred<boolean>>();
  let queueTail = Deferred.makeUnsafe<void>();
  Deferred.doneUnsafe(queueTail, Effect.void);

  let guide: GuideEntry | null = null;
  // A setup session guides each missing pane in turn. A renderer-driven guide
  // leaves the queue empty, so its close never spawns a follow-on coach.
  let guidePaneQueue: Array<HelperSettingsPane> = [];
  let guideSessionKinds: ReadonlyArray<HelperPermissionKind> = [];
  let guideSessionGeneration = 0;
  let guideSessionOpensSettings = false;
  // Only a session that opened Settings may close it again.
  let guideSessionOpenedSettings = false;

  // Closing the caller's scope marks the service disposed before helpers and
  // fibers stop, so their exits change no state.
  yield* Scope.addFinalizer(
    outer,
    Effect.sync(() => {
      disposed = true;
      guide = null;
      guidePaneQueue = [];
      guideSessionKinds = [];
      guideSessionGeneration += 1;
    }),
  );

  const snapshot = (): ComputerHelperState => ({
    supported,
    status: setupFailure ? "error" : status,
    ...(accessibility !== undefined ? { accessibilityPermission: accessibility } : {}),
    inputMonitoringPermission: inputMonitoring,
    screenRecordingPermission: screenRecording,
    message: setupFailure?.message ?? message,
    ...(setupFailure ? { permissionSetupErrorCode: setupFailure.code } : {}),
    appDisplayName: options.appDisplayName,
  });

  const getState = Effect.sync(snapshot);

  const emitState = Effect.suspend(() => {
    const state = snapshot();
    if (lastEmitted !== null && Equal.equals(state, lastEmitted)) return Effect.void;
    lastEmitted = state;
    return options.onState(state);
  });

  const setState = (next: ComputerHelperStatus, nextMessage: string | null) =>
    Effect.suspend(() => {
      const changed = status !== next || message !== nextMessage;
      status = next;
      message = nextMessage;
      return changed ? emitState : Effect.void;
    });

  const permissionOf = (kind: HelperPermissionKind) =>
    kind === "accessibility"
      ? accessibility
      : kind === "inputMonitoring"
        ? inputMonitoring
        : screenRecording;

  const panePermission = (pane: HelperSettingsPane) => permissionOf(PANE_KINDS[pane]);

  const applyPermissionReport = (report: PermissionsMessage) =>
    Effect.suspend(() => {
      for (const kind of SETUP_ORDER) if (report[kind] === "denied") grantCache.delete(kind);
      // Absent fields were not part of this request and keep their value.
      if (report.accessibility !== undefined) accessibility = report.accessibility;
      if (report.inputMonitoring !== undefined) inputMonitoring = report.inputMonitoring;
      if (report.screenRecording !== undefined) screenRecording = report.screenRecording;
      return emitState;
    });

  const permissionCheckFailed = (kinds: ReadonlyArray<HelperPermissionKind>, reason: string) =>
    Effect.suspend(() => {
      for (const kind of kinds) {
        grantCache.delete(kind);
        if (kind === "accessibility") accessibility = "unknown";
        else if (kind === "inputMonitoring") inputMonitoring = "unknown";
        else screenRecording = "unknown";
      }
      return setState("error", reason);
    });

  const spawn = (
    command: string,
    args: ReadonlyArray<string>,
    onMessage: (message: PathwayHelperMessage) => Effect.Effect<void>,
    stdin = false,
  ) =>
    Effect.suspend(() => {
      let readStderr: Effect.Effect<string> = Effect.succeed("");
      return spawnHelper(scope, {
        command,
        args,
        stdin,
        onStdoutLine: (line) => {
          const parsed = parsePathwayHelperMessage(line);
          return parsed ? onMessage(parsed) : Effect.void;
        },
        onExit: (exit) =>
          exit.code === 0
            ? Effect.void
            : readStderr.pipe(
                Effect.flatMap((stderr) =>
                  stderr.trim().length > 0
                    ? Effect.logWarning(`[desktop-computer] Native helper: ${stderr.trim()}`)
                    : Effect.void,
                ),
              ),
      }).pipe(
        Effect.tap((helper) =>
          Effect.sync(() => {
            readStderr = helper.stderr;
          }),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    });

  // One helper command at a time, in call order. The result is a Deferred so
  // concurrent callers can share an in-flight check.
  const enqueue = <A>(task: Effect.Effect<A>, fallback: A) =>
    Effect.suspend(() => {
      const result = Deferred.makeUnsafe<A>();
      if (disposed) {
        Deferred.doneUnsafe(result, Exit.succeed(fallback));
        return Effect.succeed(result);
      }
      const previous = queueTail;
      const done = Deferred.makeUnsafe<void>();
      queueTail = done;
      return Deferred.await(previous).pipe(
        Effect.andThen(task),
        Effect.onExit((exit) =>
          Deferred.succeed(result, Exit.isSuccess(exit) ? exit.value : fallback).pipe(
            Effect.andThen(Deferred.succeed(done, undefined)),
          ),
        ),
        Effect.forkIn(scope),
        Effect.as(result),
      );
    });

  const finishGuideSession = (success: boolean) =>
    Effect.suspend(() => {
      guideSessionGeneration += 1;
      const shouldCloseSettings = success && guideSessionOpenedSettings;
      guidePaneQueue = [];
      guideSessionKinds = [];
      guideSessionOpensSettings = false;
      guideSessionOpenedSettings = false;
      // A dismissed, timed-out or replaced session leaves the user's Settings alone.
      return shouldCloseSettings && options.closeSettingsApp
        ? Effect.ignoreCause(options.closeSettingsApp())
        : Effect.void;
    });

  const stopGuideGrantWatch = (entry: GuideEntry) =>
    Effect.suspend(() => {
      const fiber = entry.watch;
      entry.watch = undefined;
      return fiber ? Fiber.interrupt(fiber) : Effect.void;
    });

  const closeGuideHelper = (helper: HelperProcess) =>
    helper
      .writeLine("close")
      .pipe(
        Effect.andThen(
          Effect.sleep(GUIDE_CLOSE_GRACE_MS).pipe(
            Effect.andThen(helper.signal("SIGTERM")),
            Effect.forkIn(scope, { startImmediately: true }),
          ),
        ),
        Effect.asVoid,
      );

  const stopGuideProcess = Effect.suspend(() => {
    const entry = guide;
    if (!entry) return Effect.void;
    guide = null;
    return stopGuideGrantWatch(entry).pipe(
      Effect.andThen(entry.helper ? closeGuideHelper(entry.helper) : Effect.void),
    );
  });

  const recordPermissionSetupFailure = (error: ErrorMessage) =>
    Effect.gen(function* () {
      const code = error.code;
      if (!isSetupFailureCode(code)) return;
      setupFailure = { code, message: error.message };
      grantCache.clear();
      yield* finishGuideSession(false);
      const entry = guide;
      yield* stopGuideProcess;
      if (entry) entry.lastState = "closed";
      yield* onGuideState("closed");
      yield* setState("error", error.message);
      const capturedAt = DateTime.formatIso(yield* DateTime.now);
      if (options.onError) yield* options.onError({ code, message: error.message, capturedAt });
    });

  const executePermissionCommand = (
    command: PathwayHelperPermissionCommand,
    kinds: ReadonlyArray<HelperPermissionKind>,
    setupGeneration: number | undefined,
  ) =>
    Effect.gen(function* () {
      if (disposed || !supported) return false;
      if (Option.isNone(options.helperPath)) {
        yield* permissionCheckFailed(kinds, COMPUTER_HELPER_MISSING_MESSAGE);
        return false;
      }
      const selectors = isLegacySet(kinds)
        ? []
        : [...new Set(kinds)].flatMap((kind) => ["--permission", kind]);
      const args = [
        command,
        ...selectors,
        ...(command === PathwayHelperMode.checkPermissions
          ? []
          : ["--app-path", options.appBundlePath]),
      ];
      const current = () =>
        setupGeneration === undefined || setupGeneration === guideSessionGeneration;
      let settled = false;
      let report: PermissionsMessage | undefined;
      let reportedError: ErrorMessage | undefined;

      const finish = (ok: boolean, reason?: string) =>
        Effect.gen(function* () {
          if (disposed || !current()) return false;
          if (reportedError) yield* recordPermissionSetupFailure(reportedError);
          if (ok && report) {
            // Only a complete successful report is published; a partial or late
            // answer must never keep an old green badge.
            const now = yield* Clock.currentTimeMillis;
            for (const kind of kinds) if (report[kind] === "granted") grantCache.set(kind, now);
            yield* applyPermissionReport(report);
          } else {
            yield* permissionCheckFailed(
              kinds,
              reason ?? "The pathway-helper did not report its permission state.",
            );
          }
          return ok;
        });

      const spawned = yield* spawn(options.helperPath.value, args, (next) =>
        Effect.sync(() => {
          if (settled || !current()) return;
          if (next.type === "permissions") report = { ...report, ...next };
          else if (next.type === "error") reportedError = next;
        }),
      ).pipe(Effect.result);
      if (Result.isFailure(spawned)) {
        yield* permissionCheckFailed(
          kinds,
          `Could not inspect macOS permissions: ${spawned.failure.message}`,
        );
        return false;
      }

      // `exited` resolves after stdout drains, so every report line is in.
      const exit = yield* Effect.timeoutOption(
        spawned.success.exited,
        PERMISSION_COMMAND_TIMEOUT_MS,
      );
      settled = true;
      if (Option.isNone(exit)) {
        const result = yield* finish(false, PERMISSION_TIMEOUT_MESSAGE);
        yield* spawned.success.signal("SIGTERM");
        return result;
      }
      const completed = report;
      const complete =
        completed !== undefined && kinds.every((kind) => completed[kind] !== undefined);
      return yield* finish(
        exit.value.code === 0 && complete && reportedError === undefined,
        reportedError?.message ??
          (complete
            ? "The pathway-helper permission check did not finish successfully."
            : undefined),
      );
    });

  const runPermissionCommand = (
    command: PathwayHelperPermissionCommand,
    permissions?: ReadonlyArray<HelperPermissionKind>,
    allowCached = false,
    setupGeneration?: number,
  ): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      const kinds = permissions ?? LEGACY_KINDS;
      const key = `${allowCached ? "cached" : "fresh"}:${[...new Set(kinds)].toSorted().join(",")}`;
      const isCheck = command === PathwayHelperMode.checkPermissions;
      // Guide, settings and server may ask at once: share an in-flight probe,
      // but never serve a cached grant to the guide's fresh poll.
      const pending = isCheck ? permissionChecks.get(key) : undefined;
      if (pending) return Deferred.await(pending);
      const task = Effect.gen(function* () {
        if (setupGeneration !== undefined && setupGeneration !== guideSessionGeneration)
          return false;
        if (allowCached) {
          const now = yield* Clock.currentTimeMillis;
          const cached = kinds.every((kind) => {
            const at = grantCache.get(kind);
            return (
              at !== undefined && now - at < PERMISSION_CACHE_MS && permissionOf(kind) === "granted"
            );
          });
          if (cached) return true;
        }
        return yield* executePermissionCommand(command, kinds, setupGeneration);
      });
      return enqueue(task, false).pipe(
        Effect.flatMap((result) => {
          if (isCheck) permissionChecks.set(key, result);
          return Deferred.await(result).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (permissionChecks.get(key) === result) permissionChecks.delete(key);
              }),
            ),
          );
        }),
      );
    });

  // Rechecks before advancing so a pane flipped while the last coach was up
  // never shows a stale guide. A failed recheck ends the session.
  const recheckAndAdvance = Effect.suspend(() => {
    const generation = guideSessionGeneration;
    return runPermissionCommand(PathwayHelperMode.checkPermissions, guideSessionKinds).pipe(
      Effect.flatMap((ok) => {
        if (generation !== guideSessionGeneration || disposed) return Effect.void;
        return ok ? advancePermissionGuide : finishGuideSession(false);
      }),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });

  // The watch saw the active pane granted while the coach was up: report it,
  // retire the coach and carry a setup session to its next pane.
  const onGuidePaneGranted = (entry: GuideEntry) =>
    Effect.gen(function* () {
      if (guide !== entry) return;
      yield* stopGuideGrantWatch(entry);
      entry.lastState = "granted";
      yield* onGuideState("granted");
      yield* stopGuideProcess;
      if (guidePaneQueue.length > 0) yield* recheckAndAdvance;
    });

  /**
   * The coach's own check runs inside the long-lived guide helper, and macOS
   * never lets a running process see a fresh Accessibility grant. So a newly
   * spawned helper checks every 800ms, skipping ticks while one is in flight,
   * and the watch gives up after 10 minutes.
   */
  const startGuideGrantWatch = (entry: GuideEntry) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const tick = Effect.gen(function* () {
        yield* Effect.sleep(GUIDE_GRANT_WATCH_INTERVAL_MS);
        if (guide !== entry) return false;
        if ((yield* Clock.currentTimeMillis) - startedAt >= GUIDE_GRANT_WATCH_MAX_MS) {
          entry.watch = undefined;
          entry.lastState = "closed";
          yield* onGuideState("closed");
          yield* finishGuideSession(false);
          yield* emitState;
          yield* stopGuideProcess;
          return false;
        }
        if (entry.watchPending) return true;
        const pane = entry.pane;
        const kinds = guideSessionKinds.length > 0 ? guideSessionKinds : [PANE_KINDS[pane]];
        entry.watchPending = true;
        yield* runPermissionCommand(PathwayHelperMode.checkPermissions, kinds).pipe(
          Effect.flatMap((ok) =>
            ok && guide === entry && panePermission(pane) === "granted"
              ? onGuidePaneGranted(entry)
              : Effect.void,
          ),
          Effect.ensuring(
            Effect.sync(() => {
              entry.watchPending = false;
            }),
          ),
          Effect.forkIn(scope),
        );
        return true;
      });
      const loop = Effect.gen(function* () {
        let running = true;
        while (running) running = yield* tick;
      });
      // Starts immediately so the first tick's timer is armed before the
      // spawn returns.
      entry.watch = yield* Effect.forkIn(loop, scope, { startImmediately: true });
    });

  const onGuideExit = (entry: GuideEntry) =>
    Effect.gen(function* () {
      yield* stopGuideGrantWatch(entry);
      if (guide !== entry || disposed) return;
      guide = null;
      const finalState = entry.lastState;
      // Crash or external kill: report closed so the renderer guide stays honest.
      if (finalState !== "closed" && finalState !== "granted") {
        entry.lastState = "closed";
        yield* onGuideState("closed");
      }
      if (guidePaneQueue.length === 0) return;
      // A dismissed or crashed coach ends the session instead of respawning
      // panes the user just waved away.
      if (finalState !== "granted") return yield* finishGuideSession(false);
      yield* recheckAndAdvance;
    });

  const handleGuideMessage = (entry: GuideEntry, next: PathwayHelperMessage) =>
    Effect.suspend(() => {
      if (guide !== entry) return Effect.void;
      if (next.type === "error") return recordPermissionSetupFailure(next);
      if (next.type !== "permission-guide") return Effect.void;
      entry.lastState = next.state;
      return onGuideState(next.state);
    });

  const spawnPermissionGuide = (pane: HelperSettingsPane): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!supported || disposed || Option.isNone(options.helperPath)) return;
      yield* stopGuideProcess;
      const entry: GuideEntry = {
        pane,
        helper: undefined,
        lastState: null,
        watch: undefined,
        watchPending: false,
      };
      guide = entry;
      const spawned = yield* spawn(
        options.helperPath.value,
        [
          PathwayHelperMode.permissionGuide,
          "--pane",
          pane,
          "--app-path",
          options.appBundlePath,
          "--app-name",
          options.appDisplayName,
        ],
        (next) => handleGuideMessage(entry, next),
        true,
      ).pipe(Effect.option);
      if (Option.isNone(spawned)) {
        if (guide !== entry) return;
        guide = null;
        entry.lastState = "closed";
        yield* onGuideState("closed");
        return yield* finishGuideSession(false);
      }
      entry.helper = spawned.value;
      // Replaced or hidden while spawning.
      if (guide !== entry) return yield* closeGuideHelper(spawned.value);
      yield* startGuideGrantWatch(entry);
      yield* spawned.value.exited.pipe(Effect.andThen(onGuideExit(entry)), Effect.forkIn(scope));
    });

  // Advances a setup session to the first queued pane still missing its grant.
  const advancePermissionGuide: Effect.Effect<void> = Effect.suspend(() => {
    while (guidePaneQueue.length > 0 && panePermission(guidePaneQueue[0]!) === "granted")
      guidePaneQueue.shift();
    const pane = guidePaneQueue[0];
    // Every queued grant landed. Nothing opened means nothing to close.
    if (!pane) return finishGuideSession(true);
    const openPane =
      guideSessionOpensSettings && options.openSettingsPane
        ? Effect.ignoreCause(options.openSettingsPane(pane)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                guideSessionOpenedSettings = true;
              }),
            ),
          )
        : Effect.void;
    return openPane.pipe(Effect.andThen(spawnPermissionGuide(pane)));
  });

  const hidePermissionGuide = finishGuideSession(false).pipe(Effect.andThen(stopGuideProcess));

  const markReady = setState("ready", null).pipe(Effect.andThen(getState));

  const refreshState = (
    permissions?: ReadonlyArray<HelperPermissionKind>,
    refreshOptions: { readonly force?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      if (!supported || disposed) return snapshot();
      const ok = yield* runPermissionCommand(
        PathwayHelperMode.checkPermissions,
        permissions,
        !refreshOptions.force,
      );
      return ok ? yield* markReady : snapshot();
    });

  const requestPermissions = (permissions?: ReadonlyArray<HelperPermissionKind>) =>
    Effect.gen(function* () {
      if (!supported || disposed) return snapshot();
      setupFailure = null;
      grantCache.clear();
      const ok = yield* runPermissionCommand(PathwayHelperMode.requestPermissions, permissions);
      return ok ? yield* markReady : snapshot();
    });

  const startPermissionSetup = (permissions: ReadonlyArray<HelperPermissionKind>) =>
    Effect.gen(function* () {
      if (!supported || disposed || permissions.length === 0) return snapshot();
      yield* hidePermissionGuide;
      const generation = guideSessionGeneration;
      setupFailure = null;
      grantCache.clear();
      // A registration preflight plus a grant check, with no prompt. An
      // unresolvable copy of the app never starts a polling coach.
      const ok = yield* runPermissionCommand(
        PathwayHelperMode.preparePermissionSetup,
        permissions,
        false,
        generation,
      );
      if (!ok || disposed || generation !== guideSessionGeneration) return snapshot();
      guidePaneQueue = [...new Set(permissions)]
        .toSorted((left, right) => SETUP_ORDER.indexOf(left) - SETUP_ORDER.indexOf(right))
        .map((kind) => KIND_PANES[kind]);
      guideSessionKinds = [...permissions];
      guideSessionOpensSettings = true;
      guideSessionOpenedSettings = false;
      yield* advancePermissionGuide;
      return yield* markReady;
    });

  const showPermissionGuide = (pane: HelperSettingsPane) =>
    Effect.gen(function* () {
      // The renderer takes over the coach: any setup session ends.
      yield* finishGuideSession(false);
      setupFailure = null;
      yield* spawnPermissionGuide(pane);
    });

  const executeReleaseHeldInput = Effect.gen(function* () {
    if (disposed || !supported) return false;
    if (Option.isNone(options.helperPath)) {
      yield* setState("error", COMPUTER_HELPER_MISSING_MESSAGE);
      return false;
    }
    let released = false;
    const spawned = yield* spawn(
      options.helperPath.value,
      [PathwayHelperMode.releaseHeldInput],
      (next) =>
        Effect.sync(() => {
          if (next.type === "release-held-input" && next.released === true) released = true;
        }),
    ).pipe(Effect.option);
    if (Option.isNone(spawned)) return false;
    const exit = yield* Effect.timeoutOption(spawned.value.exited, PERMISSION_COMMAND_TIMEOUT_MS);
    if (Option.isSome(exit)) return released;
    yield* spawned.value.signal("SIGTERM");
    return false;
  });

  // Shares the permission queue so it never interleaves with a permission
  // command's helper. A silent exit means the leak may stand.
  const releaseHeldInput = enqueue(executeReleaseHeldInput, false).pipe(
    Effect.flatMap(Deferred.await),
  );

  const helper: ComputerHelper = {
    getState,
    refreshState,
    requestPermissions,
    startPermissionSetup,
    showPermissionGuide,
    hidePermissionGuide,
    releaseHeldInput,
  };
  return helper;
});
