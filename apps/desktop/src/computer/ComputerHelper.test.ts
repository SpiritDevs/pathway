import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";

import {
  COMPUTER_HELPER_MISSING_MESSAGE,
  COMPUTER_HELPER_UNSUPPORTED_MESSAGE,
  type ComputerHelper,
  type ComputerHelperErrorEvent,
  type ComputerHelperState,
  helperSettingsPaneUrl,
  make,
} from "./ComputerHelper.ts";
import type {
  HelperPermissionGuideState,
  HelperPermissionKind,
  HelperSettingsPane,
} from "./PathwayHelperProtocol.ts";
import {
  type FakeHelper,
  type FakeHelperSpawner,
  makeFakeHelperSpawner,
} from "./testing/FakeHelperSpawner.ts";

const APP_PATH = "/Applications/Pathway Test.app";
const APP_NAME = "Pathway Test";

type Grants = Record<HelperPermissionKind, "granted" | "denied">;

interface Harness {
  readonly helper: ComputerHelper;
  readonly fake: FakeHelperSpawner;
  readonly states: Array<ComputerHelperState>;
  readonly stateEvents: Queue.Queue<ComputerHelperState>;
  readonly guideStates: Array<HelperPermissionGuideState>;
  readonly guideEvents: Queue.Queue<HelperPermissionGuideState>;
  readonly errors: Array<ComputerHelperErrorEvent>;
  readonly errorEvents: Queue.Queue<ComputerHelperErrorEvent>;
  readonly openedPanes: Array<HelperSettingsPane>;
  readonly settingsClosed: Queue.Queue<void>;
  readonly settingsClosedCount: () => number;
}

const withHelper = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E>,
  config: { readonly platform?: NodeJS.Platform; readonly helperPath?: Option.Option<string> } = {},
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeHelperSpawner;
    const scope = yield* Scope.make();
    const states: Array<ComputerHelperState> = [];
    const stateEvents = yield* Queue.unbounded<ComputerHelperState>();
    const guideStates: Array<HelperPermissionGuideState> = [];
    const guideEvents = yield* Queue.unbounded<HelperPermissionGuideState>();
    const errors: Array<ComputerHelperErrorEvent> = [];
    const errorEvents = yield* Queue.unbounded<ComputerHelperErrorEvent>();
    const openedPanes: Array<HelperSettingsPane> = [];
    const settingsClosed = yield* Queue.unbounded<void>();
    let settingsClosedCount = 0;
    const helper = yield* make({
      helperPath: config.helperPath ?? Option.some("/fixture/pathway-helper"),
      appBundlePath: APP_PATH,
      appDisplayName: APP_NAME,
      onState: (state) =>
        Effect.sync(() => states.push(state)).pipe(Effect.andThen(Queue.offer(stateEvents, state))),
      onPermissionGuideState: (state) =>
        Effect.sync(() => guideStates.push(state)).pipe(
          Effect.andThen(Queue.offer(guideEvents, state)),
        ),
      onError: (error) =>
        Effect.sync(() => errors.push(error)).pipe(Effect.andThen(Queue.offer(errorEvents, error))),
      openSettingsPane: (pane) => Effect.sync(() => openedPanes.push(pane)),
      closeSettingsApp: () =>
        Effect.sync(() => {
          settingsClosedCount += 1;
        }).pipe(Effect.andThen(Queue.offer(settingsClosed, undefined))),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer),
      Effect.provideService(HostProcessPlatform, config.platform ?? "darwin"),
      Scope.provide(scope),
    );
    return yield* body({
      helper,
      fake,
      states,
      stateEvents,
      guideStates,
      guideEvents,
      errors,
      errorEvents,
      openedPanes,
      settingsClosed,
      settingsClosedCount: () => settingsClosedCount,
    }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
  });

/** Starts an operation and lets it run until it waits on a helper. */
const start = <A>(effect: Effect.Effect<A>) => Effect.forkChild(effect, { startImmediately: true });

const reply = (
  process: FakeHelper,
  permissions: Partial<Record<HelperPermissionKind, string>>,
  code = 0,
) => process.emit({ type: "permissions", ...permissions }).pipe(Effect.andThen(process.exit(code)));

const isGuide = (process: FakeHelper) => process.args[0] === "--permission-guide";

/**
 * Answers every permission command with the current `grants` (or `respond`'s
 * line), then hands it to `commands`. Guide helpers stay running and go to `guides`.
 */
const autoRespond = (
  fake: FakeHelperSpawner,
  grants: Grants,
  options: {
    readonly respond?: (args: ReadonlyArray<string>) => object;
    readonly failGuideSpawn?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const guides = yield* Queue.unbounded<FakeHelper>();
    const commands = yield* Queue.unbounded<FakeHelper>();
    yield* fake.next.pipe(
      Effect.flatMap((process) => {
        if (isGuide(process)) return Queue.offer(guides, process);
        if (options.failGuideSpawn) fake.failNextSpawn();
        return process
          .emit(options.respond?.(process.args) ?? { type: "permissions", ...grants })
          .pipe(Effect.andThen(process.exit(0)), Effect.andThen(Queue.offer(commands, process)));
      }),
      Effect.forever,
      Effect.forkChild,
    );
    return { guides, commands };
  });

const commandsOf = (fake: FakeHelperSpawner) =>
  fake.spawned.filter((process) => !isGuide(process)).map((process) => process.args);

const guidesOf = (fake: FakeHelperSpawner) => fake.spawned.filter(isGuide);

const ALL: ReadonlyArray<HelperPermissionKind> = [
  "accessibility",
  "screenRecording",
  "inputMonitoring",
];

describe("ComputerHelper permission probe freshness", () => {
  it.effect("shares simultaneous checks and serves cached grants to later callers", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const first = yield* start(helper.refreshState(ALL));
        const concurrent = yield* start(
          helper.refreshState(["screenRecording", "inputMonitoring", "accessibility"]),
        );
        const subset = yield* start(helper.refreshState());
        const check = yield* fake.next;
        yield* reply(check, {
          accessibility: "granted",
          screenRecording: "granted",
          inputMonitoring: "granted",
        });
        yield* Fiber.join(first);
        yield* Fiber.join(concurrent);
        yield* Fiber.join(subset);
        yield* helper.refreshState();
        assert.strictEqual(fake.spawned.length, 1);

        const forced = yield* start(helper.refreshState(["accessibility"], { force: true }));
        yield* reply(yield* fake.next, { accessibility: "denied" });
        assert.strictEqual((yield* Fiber.join(forced)).accessibilityPermission, "denied");
        assert.strictEqual(fake.spawned.length, 2);

        const recovery = yield* start(helper.refreshState(["accessibility"]));
        yield* reply(yield* fake.next, { accessibility: "granted" });
        assert.strictEqual((yield* Fiber.join(recovery)).accessibilityPermission, "granted");
      }),
    ),
  );

  it.effect("does not keep old green badges when the helper returns part of the grants", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const first = yield* start(helper.refreshState());
        yield* reply(yield* fake.next, { inputMonitoring: "granted", screenRecording: "granted" });
        yield* Fiber.join(first);

        const incomplete = yield* start(helper.refreshState(undefined, { force: true }));
        yield* reply(yield* fake.next, { screenRecording: "granted" });
        const failed = yield* Fiber.join(incomplete);
        assert.strictEqual(failed.status, "error");
        assert.strictEqual(failed.inputMonitoringPermission, "unknown");
        assert.strictEqual(failed.screenRecordingPermission, "unknown");

        const recovery = yield* start(helper.refreshState());
        yield* reply(yield* fake.next, { inputMonitoring: "granted", screenRecording: "granted" });
        const recovered = yield* Fiber.join(recovery);
        assert.strictEqual(recovered.status, "ready");
        assert.strictEqual(recovered.inputMonitoringPermission, "granted");
        assert.strictEqual(recovered.screenRecordingPermission, "granted");
      }),
    ),
  );

  it.effect("rejects a failed helper even if it printed a complete grant report", () =>
    withHelper(({ helper, fake, states }) =>
      Effect.gen(function* () {
        const check = yield* start(helper.refreshState(["accessibility"]));
        yield* reply(yield* fake.next, { accessibility: "granted" }, 1);
        const state = yield* Fiber.join(check);
        assert.strictEqual(state.status, "error");
        assert.strictEqual(state.accessibilityPermission, "unknown");
        assert.isFalse(states.some((next) => next.accessibilityPermission === "granted"));
      }),
    ),
  );

  it.effect("ignores late grants after a timed-out helper and allows a fresh recovery check", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const check = yield* start(helper.refreshState(["accessibility"]));
        const stuck = yield* fake.next;
        stuck.exitOnSignal = false;
        yield* TestClock.adjust(10_000);
        const timedOut = yield* Fiber.join(check);
        assert.strictEqual(timedOut.status, "error");
        assert.strictEqual(timedOut.accessibilityPermission, "unknown");
        assert.strictEqual(
          timedOut.message,
          "Checking macOS permissions timed out. Try Set up again.",
        );
        // The kill is forked into the helper's scope; one turn lets it land.
        yield* Effect.yieldNow;
        assert.deepStrictEqual(stuck.signals, ["SIGTERM"]);

        yield* reply(stuck, { accessibility: "granted" });
        const recovery = yield* start(helper.refreshState(["accessibility"]));
        const fresh = yield* fake.next;
        assert.strictEqual((yield* helper.getState).accessibilityPermission, "unknown");
        yield* reply(fresh, { accessibility: "granted" });
        assert.strictEqual((yield* Fiber.join(recovery)).accessibilityPermission, "granted");
      }),
    ),
  );

  it.effect("does not let an obsolete setup error cancel its replacement", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const obsolete = yield* start(helper.startPermissionSetup(["accessibility"]));
        const obsoleteProbe = yield* fake.next;
        const replacement = yield* start(helper.startPermissionSetup(["screenRecording"]));
        yield* obsoleteProbe.emit({
          type: "error",
          code: "permission_setup_registration_unresolved",
          message: "old error",
        });
        yield* obsoleteProbe.exit(1);
        yield* Fiber.join(obsolete);
        yield* reply(yield* fake.next, { screenRecording: "granted" });
        const state = yield* Fiber.join(replacement);
        assert.strictEqual(state.screenRecordingPermission, "granted");
        assert.isNull(state.message);
        assert.isUndefined((yield* helper.getState).permissionSetupErrorCode);
        assert.strictEqual(fake.spawned.length, 2);
      }),
    ),
  );

  it.effect("does not reopen a dismissed setup after its registration probe completes", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const setup = yield* start(
          helper.startPermissionSetup(["accessibility", "screenRecording"]),
        );
        const probe = yield* fake.next;
        yield* helper.hidePermissionGuide;
        yield* reply(probe, { accessibility: "denied", screenRecording: "denied" });
        yield* Fiber.join(setup);
        assert.strictEqual(fake.spawned.length, 1);
      }),
    ),
  );
});

describe("ComputerHelper platform state", () => {
  it.effect("checks and requests the legacy permission pair through the helper", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const check = yield* start(helper.refreshState());
        const checkProcess = yield* fake.next;
        // The legacy pair sends no --permission selectors: it is the helper's default.
        assert.deepStrictEqual(checkProcess.args, ["--check-permissions"]);
        assert.strictEqual(checkProcess.command, "/fixture/pathway-helper");
        yield* reply(checkProcess, { inputMonitoring: "denied", screenRecording: "granted" });
        const checked = yield* Fiber.join(check);
        assert.strictEqual(checked.inputMonitoringPermission, "denied");
        assert.strictEqual(checked.screenRecordingPermission, "granted");
        // Accessibility was not asked for, so the state must not invent a value.
        assert.isUndefined(checked.accessibilityPermission);
        assert.strictEqual(checked.appDisplayName, APP_NAME);

        const request = yield* start(helper.requestPermissions());
        const requestProcess = yield* fake.next;
        assert.deepStrictEqual(requestProcess.args, [
          "--request-permissions",
          "--app-path",
          APP_PATH,
        ]);
        yield* reply(requestProcess, { inputMonitoring: "granted", screenRecording: "granted" });
        const requested = yield* Fiber.join(request);
        assert.strictEqual(requested.inputMonitoringPermission, "granted");
        assert.strictEqual(requested.screenRecordingPermission, "granted");
      }),
    ),
  );

  it.effect("passes an explicit permission set as --permission selectors", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const check = yield* start(
          helper.refreshState(["accessibility", "inputMonitoring", "screenRecording"]),
        );
        const process = yield* fake.next;
        assert.deepStrictEqual(process.args, [
          "--check-permissions",
          "--permission",
          "accessibility",
          "--permission",
          "inputMonitoring",
          "--permission",
          "screenRecording",
        ]);
        yield* reply(process, {
          accessibility: "denied",
          inputMonitoring: "granted",
          screenRecording: "granted",
        });
        const state = yield* Fiber.join(check);
        assert.strictEqual(state.accessibilityPermission, "denied");
        assert.strictEqual(state.inputMonitoringPermission, "granted");
        assert.strictEqual(state.screenRecordingPermission, "granted");
      }),
    ),
  );

  it.effect("exposes an explicit unsupported state outside macOS", () =>
    withHelper(
      ({ helper, fake, states }) =>
        Effect.gen(function* () {
          const state = yield* helper.refreshState(ALL);
          assert.isFalse(state.supported);
          assert.strictEqual(state.status, "unsupported");
          assert.strictEqual(state.message, COMPUTER_HELPER_UNSUPPORTED_MESSAGE);
          yield* helper.requestPermissions(ALL);
          yield* helper.startPermissionSetup(ALL);
          yield* helper.showPermissionGuide("accessibility");
          assert.isFalse(yield* helper.releaseHeldInput);
          assert.strictEqual(fake.spawned.length, 0);
          assert.strictEqual(states.length, 0);
        }),
      { platform: "win32" },
    ),
  );

  it.effect("preserves a missing-helper error instead of reporting a permission problem", () =>
    withHelper(
      ({ helper, fake }) =>
        Effect.gen(function* () {
          const state = yield* helper.refreshState();
          assert.strictEqual(state.status, "error");
          assert.strictEqual(state.message, COMPUTER_HELPER_MISSING_MESSAGE);
          assert.isFalse(yield* helper.releaseHeldInput);
          assert.strictEqual((yield* helper.getState).message, COMPUTER_HELPER_MISSING_MESSAGE);
          assert.strictEqual(fake.spawned.length, 0);
        }),
      { helperPath: Option.none() },
    ),
  );
});

describe("ComputerHelper protocol", () => {
  it.effect("serializes permission commands and waits for stdout to drain", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const check = yield* start(helper.refreshState());
        const request = yield* start(helper.requestPermissions());
        const checkProcess = yield* fake.next;
        assert.strictEqual(fake.spawned.length, 1);
        assert.deepStrictEqual(checkProcess.args, ["--check-permissions"]);

        // The exit lands before stdout is read; the report must still count.
        yield* reply(checkProcess, { inputMonitoring: "denied", screenRecording: "denied" });
        const requestProcess = yield* fake.next;
        assert.deepStrictEqual(requestProcess.args, [
          "--request-permissions",
          "--app-path",
          APP_PATH,
        ]);
        const checked = yield* Fiber.join(check);
        assert.strictEqual(checked.status, "ready");
        assert.strictEqual(checked.inputMonitoringPermission, "denied");

        yield* reply(requestProcess, { inputMonitoring: "granted", screenRecording: "granted" });
        yield* Fiber.join(request);
        const state = yield* helper.getState;
        assert.strictEqual(state.inputMonitoringPermission, "granted");
        assert.strictEqual(state.screenRecordingPermission, "granted");
      }),
    ),
  );

  it.effect("builds System Settings URLs for each pane", () =>
    Effect.sync(() => {
      assert.strictEqual(
        helperSettingsPaneUrl("accessibility"),
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
      assert.strictEqual(
        helperSettingsPaneUrl("input-monitoring"),
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
      );
      assert.strictEqual(
        helperSettingsPaneUrl("screen-recording"),
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
    }),
  );
});

describe("ComputerHelper permission guide", () => {
  it.effect("spawns the helper in permission-guide mode with the right arguments", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        yield* helper.showPermissionGuide("input-monitoring");
        const guide = yield* fake.next;
        assert.deepStrictEqual(guide.args, [
          "--permission-guide",
          "--pane",
          "input-monitoring",
          "--app-path",
          APP_PATH,
          "--app-name",
          APP_NAME,
        ]);
        assert.deepStrictEqual(guide.stdinLines, []);
      }),
    ),
  );

  it.effect("forwards final guide states and drops shown", () =>
    withHelper(({ helper, fake, guideEvents }) =>
      Effect.gen(function* () {
        yield* helper.showPermissionGuide("input-monitoring");
        const guide = yield* fake.next;
        yield* guide.emit({ type: "permission-guide", state: "shown" });
        yield* guide.emit({ type: "permission-guide", state: "granted" });
        assert.strictEqual(yield* Queue.take(guideEvents), "granted");
      }),
    ),
  );

  it.effect("writes close and SIGTERMs the guide only after the grace period", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        yield* helper.showPermissionGuide("input-monitoring");
        const guide = yield* fake.next;
        guide.exitOnSignal = false;
        yield* helper.hidePermissionGuide;
        yield* guide.awaitStdin("close");
        assert.deepStrictEqual(guide.signals, []);
        yield* TestClock.adjust(499);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(guide.signals, []);
        yield* TestClock.adjust(1);
        // The kill is forked into the helper's scope; one turn lets it land.
        yield* Effect.yieldNow;
        assert.deepStrictEqual(guide.signals, ["SIGTERM"]);
      }),
    ),
  );

  it.effect("reports a crash as closed when no final state was emitted", () =>
    withHelper(({ helper, fake, guideEvents }) =>
      Effect.gen(function* () {
        yield* helper.showPermissionGuide("input-monitoring");
        const guide = yield* fake.next;
        yield* guide.emit({ type: "permission-guide", state: "shown" });
        yield* guide.exit(1);
        assert.strictEqual(yield* Queue.take(guideEvents), "closed");
      }),
    ),
  );

  it.effect("never raises an OS prompt while a guide is up", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const { commands } = yield* autoRespond(fake, {
          accessibility: "denied",
          inputMonitoring: "denied",
          screenRecording: "denied",
        });
        yield* helper.showPermissionGuide("accessibility");
        assert.deepStrictEqual(guidesOf(fake)[0]?.args.slice(0, 3), [
          "--permission-guide",
          "--pane",
          "accessibility",
        ]);
        yield* TestClock.adjust(800);
        const first = yield* Queue.take(commands);
        assert.deepStrictEqual(first.args, [
          "--check-permissions",
          "--permission",
          "accessibility",
        ]);
        yield* TestClock.adjust(800);
        yield* Queue.take(commands);
        assert.isFalse(commandsOf(fake).some((args) => args.includes("--request-permissions")));
      }),
    ),
  );

  it.effect("closes the guide when a fresh check sees the grant the coach cannot", () =>
    withHelper(({ helper, fake, guideEvents, guideStates }) =>
      Effect.gen(function* () {
        yield* autoRespond(fake, {
          accessibility: "granted",
          inputMonitoring: "denied",
          screenRecording: "denied",
        });
        yield* helper.showPermissionGuide("accessibility");
        assert.deepStrictEqual(guideStates, []);
        yield* TestClock.adjust(800);
        assert.strictEqual(yield* Queue.take(guideEvents), "granted");
        yield* guidesOf(fake)[0]!.awaitStdin("close");
      }),
    ),
  );

  it.effect("skips overlapping watch ticks while a grant check is in flight", () =>
    withHelper(({ helper, fake, stateEvents }) =>
      Effect.gen(function* () {
        yield* helper.showPermissionGuide("input-monitoring");
        yield* fake.next;
        yield* TestClock.adjust(800);
        const firstCheck = yield* fake.next;
        // The second tick fires while the first check has not answered.
        yield* TestClock.adjust(800);
        yield* Effect.yieldNow;
        assert.strictEqual(commandsOf(fake).length, 1);

        yield* reply(firstCheck, { inputMonitoring: "denied" });
        assert.strictEqual((yield* Queue.take(stateEvents)).inputMonitoringPermission, "denied");
        // Pending cleared: the next tick polls again.
        yield* TestClock.adjust(800);
        const secondCheck = yield* fake.next;
        assert.deepStrictEqual(secondCheck.args, [
          "--check-permissions",
          "--permission",
          "inputMonitoring",
        ]);
        assert.strictEqual(commandsOf(fake).length, 2);
      }),
    ),
  );

  it.effect("closes an ungranted guide after the 10-minute watch bound", () =>
    withHelper(({ helper, fake, guideEvents, guideStates }) =>
      Effect.gen(function* () {
        yield* autoRespond(fake, {
          accessibility: "denied",
          inputMonitoring: "denied",
          screenRecording: "denied",
        });
        yield* helper.showPermissionGuide("accessibility");
        yield* TestClock.adjust(10 * 60 * 1000);
        assert.strictEqual(yield* Queue.take(guideEvents), "closed");
        yield* guidesOf(fake)[0]!.awaitStdin("close");
        const checks = commandsOf(fake).length;
        // The watch has stopped: more time never re-emits or re-checks.
        yield* TestClock.adjust(10 * 60 * 1000);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(guideStates, ["closed"]);
        assert.strictEqual(commandsOf(fake).length, checks);
      }),
    ),
  );
});

const SETUP_FAILURE = {
  type: "error",
  code: "permission_setup_registration_unresolved",
  message: "Move this app to Applications and reopen it before granting access.",
} as const;

const ALL_GRANTED: Grants = {
  accessibility: "granted",
  inputMonitoring: "granted",
  screenRecording: "granted",
};

describe("ComputerHelper setup registration failures", () => {
  it.effect(
    "stops before opening Settings or a coach and keeps the error through passive refresh",
    () =>
      withHelper(({ helper, fake, errors, openedPanes }) =>
        Effect.gen(function* () {
          let registrationFails = true;
          yield* autoRespond(fake, ALL_GRANTED, {
            respond: (args) =>
              args[0] === "--prepare-permission-setup" && registrationFails
                ? SETUP_FAILURE
                : { type: "permissions", ...ALL_GRANTED },
          });

          const failed = yield* helper.startPermissionSetup(ALL);
          assert.strictEqual(failed.status, "error");
          assert.strictEqual(failed.message, SETUP_FAILURE.message);
          assert.strictEqual(failed.permissionSetupErrorCode, SETUP_FAILURE.code);
          assert.deepStrictEqual(commandsOf(fake)[0], [
            "--prepare-permission-setup",
            "--permission",
            "accessibility",
            "--permission",
            "screenRecording",
            "--permission",
            "inputMonitoring",
            "--app-path",
            APP_PATH,
          ]);
          assert.deepStrictEqual(openedPanes, []);
          assert.strictEqual(errors.length, 1);
          assert.strictEqual(errors[0]?.code, SETUP_FAILURE.code);
          assert.strictEqual(errors[0]?.message, SETUP_FAILURE.message);

          const refreshed = yield* helper.refreshState(ALL);
          assert.strictEqual(refreshed.status, "error");
          assert.strictEqual(refreshed.message, SETUP_FAILURE.message);
          assert.strictEqual(refreshed.permissionSetupErrorCode, SETUP_FAILURE.code);
          assert.deepStrictEqual(
            commandsOf(fake).map((args) => args[0]),
            ["--prepare-permission-setup", "--check-permissions"],
          );

          registrationFails = false;
          assert.isNull((yield* helper.startPermissionSetup(ALL)).message);
          assert.isUndefined((yield* helper.getState).permissionSetupErrorCode);
          assert.deepStrictEqual(openedPanes, []);
        }),
      ),
  );

  it.effect("drains an exiting coach's registration failure and cancels its poll", () =>
    withHelper(({ helper, fake, errorEvents, errors, guideStates }) =>
      Effect.gen(function* () {
        yield* helper.showPermissionGuide("screen-recording");
        const guide = yield* fake.next;
        yield* guide.emit(SETUP_FAILURE);
        yield* guide.exit(1);
        yield* Queue.take(errorEvents);
        const state = yield* helper.getState;
        assert.strictEqual(state.status, "error");
        assert.strictEqual(state.message, SETUP_FAILURE.message);
        assert.deepStrictEqual(guideStates, ["closed"]);
        // The coach already exited, so its close line has no stdin to land on.
        // Its grant watch must not outlive it.
        yield* TestClock.adjust(2_500);
        yield* Effect.yieldNow;
        assert.strictEqual(fake.spawned.length, 1);
        assert.strictEqual(errors.length, 1);
      }),
    ),
  );
});

describe("ComputerHelper permission setup sessions", () => {
  it.effect("walks each missing pane in sequence with no OS prompt, then closes Settings", () =>
    withHelper(({ helper, fake, openedPanes, settingsClosed, settingsClosedCount }) =>
      Effect.gen(function* () {
        const grants: Grants = {
          accessibility: "denied",
          inputMonitoring: "denied",
          screenRecording: "denied",
        };
        const { guides } = yield* autoRespond(fake, grants);
        // Out of order with a duplicate: the session still walks each pane once, in order.
        yield* helper.startPermissionSetup(["screenRecording", "accessibility", "screenRecording"]);
        const first = yield* Queue.take(guides);
        assert.strictEqual(first.args[2], "accessibility");
        assert.deepStrictEqual(openedPanes, ["accessibility"]);

        // The grant watch sees Accessibility flip and advances to Screen Recording.
        grants.accessibility = "granted";
        yield* TestClock.adjust(800);
        const second = yield* Queue.take(guides);
        assert.strictEqual(second.args[2], "screen-recording");
        yield* first.awaitStdin("close");
        assert.deepStrictEqual(openedPanes, ["accessibility", "screen-recording"]);

        grants.screenRecording = "granted";
        yield* TestClock.adjust(800);
        yield* Queue.take(settingsClosed);
        yield* second.awaitStdin("close");
        assert.strictEqual(settingsClosedCount(), 1);
        assert.strictEqual(guidesOf(fake).length, 2);
        assert.strictEqual(openedPanes.length, 2);
        assert.isFalse(commandsOf(fake).some((args) => args.includes("--request-permissions")));
      }),
    ),
  );

  it.effect("skips panes that are already granted", () =>
    withHelper(({ helper, fake, openedPanes, settingsClosedCount }) =>
      Effect.gen(function* () {
        yield* autoRespond(fake, {
          accessibility: "granted",
          inputMonitoring: "denied",
          screenRecording: "denied",
        });
        yield* helper.startPermissionSetup(["accessibility", "screenRecording"]);
        assert.deepStrictEqual(openedPanes, ["screen-recording"]);
        assert.strictEqual(guidesOf(fake).length, 1);
        // Still mid-walk: Settings stays open.
        assert.strictEqual(settingsClosedCount(), 0);
        assert.isFalse(commandsOf(fake).some((args) => args.includes("--request-permissions")));
      }),
    ),
  );

  it.effect("ends the session when the coach is dismissed instead of respawning", () =>
    withHelper(({ helper, fake, guideEvents, settingsClosedCount }) =>
      Effect.gen(function* () {
        const { guides } = yield* autoRespond(fake, {
          accessibility: "denied",
          inputMonitoring: "denied",
          screenRecording: "denied",
        });
        yield* helper.startPermissionSetup(["accessibility", "screenRecording"]);
        const coach = yield* Queue.take(guides);
        yield* coach.exit(0);
        assert.strictEqual(yield* Queue.take(guideEvents), "closed");
        yield* TestClock.adjust(900);
        yield* Effect.yieldNow;
        assert.strictEqual(guidesOf(fake).length, 1);
        assert.deepStrictEqual(
          commandsOf(fake).map((args) => args[0]),
          ["--prepare-permission-setup"],
        );
        assert.strictEqual(settingsClosedCount(), 0);
      }),
    ),
  );

  it.effect("reports closed and ends the session when the guide helper fails to spawn", () =>
    withHelper(({ helper, fake, guideStates, settingsClosedCount }) =>
      Effect.gen(function* () {
        yield* autoRespond(
          fake,
          { accessibility: "denied", inputMonitoring: "denied", screenRecording: "denied" },
          { failGuideSpawn: true },
        );
        yield* helper.startPermissionSetup(["accessibility", "screenRecording"]);
        assert.deepStrictEqual(guideStates, ["closed"]);
        yield* TestClock.adjust(900);
        yield* Effect.yieldNow;
        assert.strictEqual(fake.spawned.length, 1);
        assert.strictEqual(settingsClosedCount(), 0);
      }),
    ),
  );

  it.effect("opens and closes nothing when every grant is already held", () =>
    withHelper(({ helper, fake, openedPanes, settingsClosedCount }) =>
      Effect.gen(function* () {
        yield* autoRespond(fake, ALL_GRANTED);
        const state = yield* helper.startPermissionSetup(["accessibility", "screenRecording"]);
        assert.strictEqual(state.status, "ready");
        assert.strictEqual(guidesOf(fake).length, 0);
        assert.deepStrictEqual(openedPanes, []);
        assert.strictEqual(settingsClosedCount(), 0);
      }),
    ),
  );
});

describe("ComputerHelper held input release", () => {
  it.effect("reports true only when the helper confirms the release", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const release = yield* start(helper.releaseHeldInput);
        const process = yield* fake.next;
        assert.deepStrictEqual(process.args, ["--release-held-input"]);
        yield* process.emit({ type: "release-held-input", released: true });
        yield* process.exit(0);
        assert.isTrue(yield* Fiber.join(release));
      }),
    ),
  );

  it.effect("reports false when the helper exits without confirming", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const release = yield* start(helper.releaseHeldInput);
        yield* (yield* fake.next).exit(0);
        assert.isFalse(yield* Fiber.join(release));
      }),
    ),
  );

  it.effect("kills a wedged helper and reports false after the timeout", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const release = yield* start(helper.releaseHeldInput);
        const process = yield* fake.next;
        process.exitOnSignal = false;
        yield* TestClock.adjust(10_000);
        assert.isFalse(yield* Fiber.join(release));
        yield* Effect.yieldNow;
        assert.deepStrictEqual(process.signals, ["SIGTERM"]);
      }),
    ),
  );

  it.effect("waits behind a queued permission command", () =>
    withHelper(({ helper, fake }) =>
      Effect.gen(function* () {
        const check = yield* start(helper.refreshState());
        const release = yield* start(helper.releaseHeldInput);
        const checkProcess = yield* fake.next;
        assert.strictEqual(fake.spawned.length, 1);
        yield* reply(checkProcess, { inputMonitoring: "granted", screenRecording: "granted" });
        const releaseProcess = yield* fake.next;
        assert.deepStrictEqual(releaseProcess.args, ["--release-held-input"]);
        yield* releaseProcess.emit({ type: "release-held-input", released: true });
        yield* releaseProcess.exit(0);
        yield* Fiber.join(check);
        assert.isTrue(yield* Fiber.join(release));
      }),
    ),
  );
});
