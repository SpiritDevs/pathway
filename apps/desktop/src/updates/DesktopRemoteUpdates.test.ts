import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopTelemetryRequestDesktopUpdate,
  DesktopTelemetryCommitDesktopUpdate,
  DesktopTelemetryCancelDesktopUpdate,
  DesktopUpdateStatusReport,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopRemoteUpdates from "./DesktopRemoteUpdates.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

/** Drains scheduled workers, including updater event fibers created by runPromise.
 * Each test owns its scheduler, so no fixed microtask count or elapsed time is needed.
 */
function makeWorkerScheduler() {
  const underlying = new Scheduler.MixedScheduler();
  const pending = new Set<Scheduler.SchedulerDispatcher>();
  const scheduler: Scheduler.Scheduler = {
    executionMode: underlying.executionMode,
    shouldYield: (fiber) => underlying.shouldYield(fiber),
    makeDispatcher: () => {
      const dispatcher = underlying.makeDispatcher();
      const tracked: Scheduler.SchedulerDispatcher = {
        scheduleTask: (task, priority) => {
          pending.add(tracked);
          dispatcher.scheduleTask(task, priority);
        },
        flush: () => {
          pending.delete(tracked);
          dispatcher.flush();
        },
      };
      return tracked;
    },
  };
  return {
    scheduler,
    // A receipt can resume the test inline in a worker. Yield out of that
    // worker first so draining can finish its continuation as well.
    drainWorkers: Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.sync(() => {
          while (pending.size > 0) {
            for (const dispatcher of pending) dispatcher.flush();
          }
        }),
      ),
    ),
  };
}

const request = (requestId: string): DesktopTelemetryRequestDesktopUpdate => ({
  version: 1,
  type: "requestDesktopUpdate",
  requestId,
});

function runRemoteUpdatesTest(
  harness: ReturnType<typeof makeHarness>,
  body: (context: {
    readonly drainWorkers: Effect.Effect<void>;
    readonly reports: DesktopUpdateStatusReport[];
    readonly requests: Queue.Queue<DesktopTelemetryRequestDesktopUpdate>;
    readonly commits: Queue.Queue<DesktopTelemetryCommitDesktopUpdate>;
    readonly cancellations: Queue.Queue<DesktopTelemetryCancelDesktopUpdate>;
  }) => Effect.Effect<void, never, DesktopUpdates.DesktopUpdates | DesktopState.DesktopState>,
) {
  const { scheduler, drainWorkers } = makeWorkerScheduler();
  return Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<DesktopTelemetryRequestDesktopUpdate>();
      const commits = yield* Queue.unbounded<DesktopTelemetryCommitDesktopUpdate>();
      const cancellations = yield* Queue.unbounded<DesktopTelemetryCancelDesktopUpdate>();
      const reports: DesktopUpdateStatusReport[] = [];
      const publisher = DesktopTelemetryPublisher.DesktopTelemetryPublisher.of({
        latest: Effect.succeedNone,
        changes: Stream.empty,
        encoded: Stream.empty,
        handleControl: () => Effect.void,
        handleControlForSource: () => Effect.void,
        removeControlSource: () => Effect.void,
        publishUpdateReport: (report) =>
          Effect.sync(() => {
            reports.push(report);
          }),
        updateRequests: Stream.fromQueue(requests),
        updateCommits: Stream.fromQueue(commits),
        updateCancellations: Stream.fromQueue(cancellations),
      });

      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* DesktopRemoteUpdates.listen.pipe(
        Effect.provideService(DesktopTelemetryPublisher.DesktopTelemetryPublisher, publisher),
      );
      yield* drainWorkers;
      yield* body({ drainWorkers, reports, requests, commits, cancellations });
    }),
  ).pipe(
    Effect.provide(Layer.merge(TestClock.layer(), harness.layer)),
    Effect.provideService(Scheduler.Scheduler, scheduler),
  );
}

function terminalReports(reports: DesktopUpdateStatusReport[]): DesktopUpdateStatusReport[] {
  return reports.filter((report) => report.outcome !== undefined);
}

describe("DesktopRemoteUpdates", () => {
  it.effect("drives check, download, and install with no local confirmation", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-1"));
        yield* drainWorkers;
        assert.equal(harness.checkCount(), 1);

        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;

        const terminals = terminalReports(reports);
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0]?.outcome, "ready-to-install");
        assert.equal(terminals[0]?.requestId, "req-1");
        assert.equal(harness.quitAndInstalls(), 0);

        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-1",
        });
        yield* drainWorkers;
        assert.equal(harness.quitAndInstalls(), 1);

        // The mirror stamped the in-run state changes with the request id.
        const statuses = reports
          .filter((report) => report.requestId === "req-1")
          .map((report) => report.state.status);
        assert.include(statuses, "available");
        assert.include(statuses, "downloaded");
      }),
    );
  });

  it.effect("reports a failed outcome when quitAndInstall fails", () => {
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("spawn failed"),
        }),
      ),
    });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-4"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;

        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-4",
        });
        yield* drainWorkers;

        // Install failures reduce to status "downloaded" + errorContext
        // "install"; the prepared result is followed by the commit failure.
        const terminals = terminalReports(reports);
        assert.deepEqual(
          terminals.map((report) => report.outcome),
          ["ready-to-install", "failed"],
        );
        assert.equal(terminals[1]?.state.errorContext, "install");
      }),
    );
  });

  it.effect("joins an in-progress install on commit instead of failing the token", () => {
    const installStarted = Deferred.makeUnsafe<void>();
    const releaseInstall = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      stopBackend: Deferred.succeed(installStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseInstall)),
      ),
    });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests, commits }) =>
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* Queue.offer(requests, request("req-join-commit"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;
        assert.deepEqual(
          terminalReports(reports).map((report) => report.outcome),
          ["ready-to-install"],
        );

        // A local install takes the updater reservation and starts shutdown.
        const localInstall = yield* updates.install.pipe(Effect.forkChild);
        yield* Deferred.await(installStarted);
        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-join-commit",
        });
        yield* drainWorkers;

        // No "failed" marker: that install relaunches the app and the
        // client proves the handoff by reconnecting on the target version.
        assert.deepEqual(
          terminalReports(reports).map((report) => report.outcome),
          ["ready-to-install"],
        );
        assert.equal(harness.quitAndInstalls(), 0);

        yield* Deferred.succeed(releaseInstall, undefined);
        yield* Fiber.join(localInstall);
      }),
    );
  });

  it.effect("does not join a normal app quit as an update install", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests, commits }) =>
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        yield* Queue.offer(requests, request("req-normal-quit"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;

        yield* Ref.set(desktopState.quitting, true);
        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-normal-quit",
        });
        yield* drainWorkers;

        assert.deepEqual(
          terminalReports(reports).map((report) => report.outcome),
          ["ready-to-install", "failed"],
        );
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });

  it.effect("does not misread a lingering install error as a failed retry", () => {
    let installAttempts = 0;
    const harness = makeHarness({
      quitAndInstall: Effect.suspend(() => {
        installAttempts += 1;
        return installAttempts === 1
          ? Effect.fail(
              new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
                channel: "latest",
                isSilent: true,
                isForceRunAfter: true,
                cause: new Error("first attempt failed"),
              }),
            )
          : Effect.void;
      }),
    });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-5"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;
        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-5",
        });
        yield* drainWorkers;
        // First run failed; state is "downloaded" with a lingering
        // errorContext "install". The retry succeeds and must not report
        // that leftover as a fresh failure.
        yield* Queue.offer(requests, request("req-6"));
        yield* drainWorkers;
        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-6",
        });
        yield* drainWorkers;

        const retryTerminals = terminalReports(reports).filter(
          (report) => report.requestId === "req-6",
        );
        assert.deepEqual(
          retryTerminals.map((report) => report.outcome),
          ["ready-to-install"],
        );
        assert.equal(harness.quitAndInstalls(), 2);
      }),
    );
  });

  it.effect("ignores an unrelated updater event while an install is starting", () => {
    const stopStarted = Deferred.makeUnsafe<void>();
    const releaseStop = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      stopBackend: Deferred.succeed(stopStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseStop)),
      ),
    });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-late-event"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;

        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-late-event",
        });
        yield* Deferred.await(stopStarted);
        harness.emit("download-progress", { percent: 90 });
        yield* drainWorkers;
        yield* Deferred.succeed(releaseStop, undefined);
        yield* drainWorkers;

        assert.deepEqual(
          terminalReports(reports)
            .filter((report) => report.requestId === "req-late-event")
            .map((report) => report.outcome),
          ["ready-to-install"],
        );
      }),
    );
  });

  it.effect("retries a download refused while the check still holds the reservation", () => {
    // electron-updater emits update-available from inside checkForUpdates,
    // before the check action releases its reservation. The download the
    // remote flow forks in response is refused and must be retried once the
    // reservation frees up, without burning a download attempt.
    const releaseCheck = Deferred.makeUnsafe<void>();
    const harness = makeHarness({ checkForUpdates: Deferred.await(releaseCheck) });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-8"));
        yield* drainWorkers;
        assert.equal(harness.checkCount(), 1);

        // Fire "available" while the check reservation is still held.
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        assert.equal(harness.downloadCount(), 0);

        yield* Deferred.succeed(releaseCheck, undefined);
        yield* drainWorkers;
        yield* TestClock.adjust(Duration.millis(300));
        yield* drainWorkers;
        assert.equal(harness.downloadCount(), 1);

        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;
        assert.deepEqual(
          terminalReports(reports).map((report) => report.outcome),
          ["ready-to-install"],
        );
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });

  it.effect("waits for the download reservation before reporting prepared", () => {
    // update-downloaded fires from inside downloadUpdate. If the flow
    // reported "installing" right then, install would be refused for the
    // held reservation after the irrevocable terminal already went out.
    const releaseDownload = Deferred.makeUnsafe<void>();
    const harness = makeHarness({ downloadUpdate: Deferred.await(releaseDownload) });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-10"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;
        assert.deepEqual(terminalReports(reports), []);
        assert.equal(harness.quitAndInstalls(), 0);

        yield* Deferred.succeed(releaseDownload, undefined);
        yield* drainWorkers;
        yield* TestClock.adjust(Duration.millis(300));
        yield* drainWorkers;
        assert.deepEqual(
          terminalReports(reports).map((report) => report.outcome),
          ["ready-to-install"],
        );
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });

  it.effect("joins an install that is already tearing the app down", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests }) =>
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;
        // Another install already owns the shutdown.
        yield* Ref.set(desktopState.quitting, true);

        yield* Queue.offer(requests, request("req-9"));
        yield* drainWorkers;

        // Report "installing" once, no "failed" after the refusal: that
        // install will relaunch the app and this request rides along.
        assert.deepEqual(
          terminalReports(reports).map((report) => report.outcome),
          ["ready-to-install"],
        );
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });

  it.effect("does not run the installer twice for a repeated commit", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ drainWorkers, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-repeat"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;

        const commit = {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-repeat",
        } as const;
        yield* Queue.offer(commits, commit);
        yield* drainWorkers;
        yield* Queue.offer(commits, commit);
        yield* drainWorkers;

        assert.equal(harness.quitAndInstalls(), 1);
      }),
    );
  });

  it.effect("waits for a background check before installing a prepared update", () => {
    const backgroundCheckStarted = Deferred.makeUnsafe<void>();
    const releaseBackgroundCheck = Deferred.makeUnsafe<void>();
    let checks = 0;
    const harness = makeHarness({
      checkForUpdates: Effect.suspend(() => {
        checks += 1;
        return checks === 2
          ? Deferred.succeed(backgroundCheckStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseBackgroundCheck)),
            )
          : Effect.void;
      }),
    });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, requests, commits }) =>
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* Queue.offer(requests, request("req-background-check"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;

        const backgroundCheck = yield* updates.check("poll").pipe(Effect.forkChild);
        yield* Deferred.await(backgroundCheckStarted);
        assert.equal((yield* updates.getState).status, "checking");

        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-background-check",
        });
        yield* drainWorkers;
        assert.equal(harness.quitAndInstalls(), 0);

        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Deferred.succeed(releaseBackgroundCheck, undefined);
        yield* Fiber.join(backgroundCheck);
        yield* drainWorkers;
        assert.equal(harness.quitAndInstalls(), 1);
      }),
    );
  });

  it.effect("fails a prepared install when its background check stays blocked", () => {
    const backgroundCheckStarted = Deferred.makeUnsafe<void>();
    const releaseBackgroundCheck = Deferred.makeUnsafe<void>();
    let checks = 0;
    const harness = makeHarness({
      checkForUpdates: Effect.suspend(() => {
        checks += 1;
        return checks === 2
          ? Deferred.succeed(backgroundCheckStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseBackgroundCheck)),
            )
          : Effect.void;
      }),
    });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests, commits }) =>
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* Queue.offer(requests, request("req-blocked-background-check"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;

        const backgroundCheck = yield* updates.check("poll").pipe(Effect.forkChild);
        yield* Deferred.await(backgroundCheckStarted);
        const commit = {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-blocked-background-check",
        } as const;
        yield* Queue.offer(commits, commit);
        yield* drainWorkers;
        yield* TestClock.adjust(Duration.seconds(91));
        yield* drainWorkers;

        assert.equal(harness.quitAndInstalls(), 0);
        assert.deepEqual(
          terminalReports(reports)
            .filter((report) => report.requestId === "req-blocked-background-check")
            .map((report) => report.outcome),
          ["ready-to-install", "failed"],
        );

        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Deferred.succeed(releaseBackgroundCheck, undefined);
        yield* Fiber.join(backgroundCheck);
        yield* drainWorkers;
        assert.equal(harness.quitAndInstalls(), 0);

        yield* Queue.offer(commits, commit);
        yield* drainWorkers;
        assert.deepEqual(
          terminalReports(reports)
            .filter((report) => report.requestId === "req-blocked-background-check")
            .map((report) => report.outcome),
          ["ready-to-install", "failed", "failed"],
        );
      }),
    );
  });

  it.effect("rejects a new preparation while an install commit is active", () => {
    const installStarted = Deferred.makeUnsafe<void>();
    const releaseInstall = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      quitAndInstall: Deferred.succeed(installStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseInstall)),
        Effect.andThen(
          Effect.fail(
            new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
              channel: "latest",
              isSilent: true,
              isForceRunAfter: true,
              cause: new Error("installer refused"),
            }),
          ),
        ),
      ),
    });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-active"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;
        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-active",
        });
        yield* Deferred.await(installStarted);

        yield* Queue.offer(requests, request("req-overlap"));
        yield* drainWorkers;
        const overlap = terminalReports(reports).find(
          (report) => report.requestId === "req-overlap",
        );
        assert.equal(overlap?.outcome, "failed");
        assert.equal(overlap?.reason, "A prepared desktop update is already in progress.");

        yield* Deferred.succeed(releaseInstall, undefined);
        yield* drainWorkers;
      }),
    );
  });

  it.effect("cancels an active preparation so the next request can run", () => {
    const releaseCheck = Deferred.makeUnsafe<void>();
    const harness = makeHarness({ checkForUpdates: Deferred.await(releaseCheck) });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, requests, cancellations }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-cancel"));
        yield* drainWorkers;
        yield* Queue.offer(cancellations, {
          version: 1,
          type: "cancelDesktopUpdate",
          requestId: "req-cancel",
        });
        yield* drainWorkers;
        yield* Deferred.succeed(releaseCheck, undefined);
        yield* Queue.offer(requests, request("req-next"));
        yield* drainWorkers;

        assert.equal(harness.checkCount(), 2);
      }),
    );
  });

  it.effect("remembers a cancellation that arrives before its request starts", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ drainWorkers, requests, cancellations }) =>
      Effect.gen(function* () {
        yield* Queue.offer(cancellations, {
          version: 1,
          type: "cancelDesktopUpdate",
          requestId: "req-early-cancel",
        });
        yield* Queue.offer(requests, request("req-early-cancel"));
        yield* drainWorkers;

        assert.equal(harness.checkCount(), 0);

        yield* Queue.offer(requests, request("req-after-early-cancel"));
        yield* drainWorkers;
        assert.equal(harness.checkCount(), 1);
      }),
    );
  });

  it.effect("keeps every queued cancellation until its request starts", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ drainWorkers, requests, cancellations }) =>
      Effect.gen(function* () {
        for (let index = 0; index < 40; index += 1) {
          yield* Queue.offer(cancellations, {
            version: 1,
            type: "cancelDesktopUpdate",
            requestId: `req-queued-cancel-${index}`,
          });
        }
        yield* drainWorkers;
        for (let index = 0; index < 40; index += 1) {
          yield* Queue.offer(requests, request(`req-queued-cancel-${index}`));
        }
        yield* drainWorkers;
        assert.equal(harness.checkCount(), 0);

        yield* Queue.offer(requests, request("req-after-queued-cancels"));
        yield* drainWorkers;
        assert.equal(harness.checkCount(), 1);
      }),
    );
  });

  it.effect("does not install after cancellation wins the commit claim", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(
      harness,
      ({ drainWorkers, reports, requests, commits, cancellations }) =>
        Effect.gen(function* () {
          yield* Queue.offer(requests, request("req-cancel-before-commit"));
          yield* drainWorkers;
          harness.emit("update-available", { version: "1.2.4" });
          yield* drainWorkers;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* drainWorkers;

          yield* Queue.offer(cancellations, {
            version: 1,
            type: "cancelDesktopUpdate",
            requestId: "req-cancel-before-commit",
          });
          yield* drainWorkers;
          yield* Queue.offer(commits, {
            version: 1,
            type: "commitDesktopUpdate",
            requestId: "req-cancel-before-commit",
          });
          yield* drainWorkers;

          assert.equal(harness.quitAndInstalls(), 0);
          assert.deepEqual(
            terminalReports(reports)
              .filter((report) => report.requestId === "req-cancel-before-commit")
              .map((report) => report.outcome),
            ["ready-to-install", "failed"],
          );
        }),
    );
  });

  it.effect("retains an install failure after cancellation loses the commit claim", () => {
    const installStarted = Deferred.makeUnsafe<void>();
    const releaseInstall = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      quitAndInstall: Deferred.succeed(installStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseInstall)),
        Effect.andThen(
          Effect.fail(
            new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
              channel: "latest",
              isSilent: true,
              isForceRunAfter: true,
              cause: new Error("installer refused"),
            }),
          ),
        ),
      ),
    });

    return runRemoteUpdatesTest(
      harness,
      ({ drainWorkers, reports, requests, commits, cancellations }) =>
        Effect.gen(function* () {
          yield* Queue.offer(requests, request("req-cancel-after-commit"));
          yield* drainWorkers;
          harness.emit("update-available", { version: "1.2.4" });
          yield* drainWorkers;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* drainWorkers;
          const commit = {
            version: 1,
            type: "commitDesktopUpdate",
            requestId: "req-cancel-after-commit",
          } as const;
          yield* Queue.offer(commits, commit);
          yield* Deferred.await(installStarted);
          yield* Queue.offer(cancellations, {
            version: 1,
            type: "cancelDesktopUpdate",
            requestId: "req-cancel-after-commit",
          });
          yield* drainWorkers;
          yield* Deferred.succeed(releaseInstall, undefined);
          yield* drainWorkers;
          yield* Queue.offer(commits, commit);
          yield* drainWorkers;

          assert.deepEqual(
            terminalReports(reports)
              .filter((report) => report.requestId === "req-cancel-after-commit")
              .map((report) => report.outcome),
            ["ready-to-install", "failed", "failed"],
          );
        }),
    );
  });

  it.effect("expires an uncommitted preparation", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-stale"));
        yield* drainWorkers;
        harness.emit("update-available", { version: "1.2.4" });
        yield* drainWorkers;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* drainWorkers;

        yield* TestClock.setTime(Duration.toMillis(Duration.minutes(6)));
        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-stale",
        });
        yield* drainWorkers;

        const outcomes = terminalReports(reports)
          .filter((report) => report.requestId === "req-stale")
          .map((report) => report.outcome);
        assert.deepEqual(outcomes, ["ready-to-install", "failed"]);
      }),
    );
  });

  it.effect("reports up-to-date without installing when there is no update", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-2"));
        yield* drainWorkers;
        harness.emit("update-not-available");
        yield* drainWorkers;

        const terminals = terminalReports(reports);
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0]?.outcome, "up-to-date");
        assert.equal(terminals[0]?.requestId, "req-2");
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });

  it.effect("fails fast with the disabled reason when updates are off", () => {
    const harness = makeHarness({ env: { PATHWAY_DISABLE_AUTO_UPDATE: "true" } });

    return runRemoteUpdatesTest(harness, ({ drainWorkers, reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-3"));
        yield* drainWorkers;

        const terminals = terminalReports(reports);
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0]?.outcome, "failed");
        assert.equal(
          terminals[0]?.reason,
          "Automatic updates are disabled by the PATHWAY_DISABLE_AUTO_UPDATE setting.",
        );
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });
});
