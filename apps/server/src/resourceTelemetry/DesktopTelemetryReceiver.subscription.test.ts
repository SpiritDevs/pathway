import { it } from "@effect/vitest";
import type { DesktopUpdateStatusReport } from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { subscribeDesktopUpdateReports } from "./DesktopTelemetryReceiver.ts";

for (const outcome of ["ready-to-install", "failed"] as const) {
  it.effect(`retains ${outcome} when report and EOF arrive during the subscription snapshot`, () =>
    Effect.gen(function* () {
      const reports = yield* PubSub.sliding<Option.Option<DesktopUpdateStatusReport>>(16);
      const latest = yield* Ref.make(Option.none<DesktopUpdateStatusReport>());
      const closed = yield* Ref.make(false);
      const snapshotRead = yield* Deferred.make<void>();
      const resumeSnapshot = yield* Deferred.make<void>();
      const snapshot = Ref.get(latest).pipe(
        Effect.tap(() =>
          Deferred.succeed(snapshotRead, undefined).pipe(
            Effect.andThen(Deferred.await(resumeSnapshot)),
          ),
        ),
      );
      const subscriptionFiber = yield* subscribeDesktopUpdateReports(
        reports,
        Ref.get(closed),
        snapshot,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(snapshotRead);
      const finalReport: DesktopUpdateStatusReport = {
        version: 1,
        type: "desktopUpdateStatus",
        requestId: "prepared-update-token",
        outcome,
        ...(outcome === "failed" ? { reason: "Installer failed; backend restored" } : {}),
        state: {
          enabled: true,
          status: "downloaded",
          channel: "latest",
          currentVersion: "1.2.3",
          availableVersion: "1.2.4",
          downloadedVersion: "1.2.4",
          hostArch: "arm64",
          appArch: "arm64",
          runningUnderArm64Translation: false,
          releaseNotes: [],
          downloadPercent: 100,
          checkedAt: null,
          message: null,
          errorContext: outcome === "failed" ? "install" : null,
          canRetry: outcome === "failed",
        },
      };
      yield* Ref.set(latest, Option.some(finalReport));
      yield* PubSub.publish(reports, Option.some(finalReport));
      yield* Ref.set(closed, true);
      yield* PubSub.publish(reports, Option.none());
      yield* Deferred.succeed(resumeSnapshot, undefined);
      const subscription = yield* Fiber.join(subscriptionFiber);
      expect(subscription.latest).toEqual(Option.none());
      expect(yield* Stream.runCollect(subscription.changes)).toEqual([finalReport]);

      const lateSubscription = yield* subscribeDesktopUpdateReports(
        reports,
        Ref.get(closed),
        Ref.get(latest),
      );
      expect(lateSubscription.latest).toEqual(Option.some(finalReport));
      expect(yield* Stream.runCollect(lateSubscription.changes)).toEqual([]);
    }).pipe(Effect.scoped),
  );
}
