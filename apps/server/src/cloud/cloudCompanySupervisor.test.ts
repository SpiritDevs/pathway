import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import { superviseCloudSyncCompanies } from "./syncDaemon.ts";

const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");
const COMPANY_C = CompanyId.make("company-c");

describe("superviseCloudSyncCompanies", () => {
  it.effect("adds and removes workers while a failed listing preserves the current set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const listings = yield* Queue.unbounded<ReadonlyArray<CompanyId> | "offline">();
        const discoveries = yield* Queue.unbounded<void>();
        const events = yield* Queue.unbounded<string>();
        const discover = () =>
          Queue.take(listings).pipe(
            Effect.tap(() => Queue.offer(discoveries, undefined)),
            Effect.flatMap((value) =>
              value === "offline" ? Effect.fail("offline") : Effect.succeed(value),
            ),
          );
        const runCompany = (companyId: CompanyId) =>
          Effect.acquireRelease(Queue.offer(events, `start:${companyId}`), () =>
            Queue.offer(events, `stop:${companyId}`),
          ).pipe(Effect.andThen(Effect.never));

        yield* Queue.offer(listings, [COMPANY_A, COMPANY_B]);
        yield* Effect.forkScoped(
          superviseCloudSyncCompanies({
            discover,
            runCompany,
            workerLabel: "test",
            reconcileInterval: 0,
          }),
        );
        expect(new Set([yield* Queue.take(events), yield* Queue.take(events)])).toEqual(
          new Set([`start:${COMPANY_A}`, `start:${COMPANY_B}`]),
        );

        yield* Queue.offer(listings, "offline");
        yield* Queue.take(discoveries);
        yield* Queue.take(discoveries);
        expect(yield* Queue.size(events)).toBe(0);

        yield* Queue.offer(listings, [COMPANY_B, COMPANY_C]);
        expect(new Set([yield* Queue.take(events), yield* Queue.take(events)])).toEqual(
          new Set([`stop:${COMPANY_A}`, `start:${COMPANY_C}`]),
        );
      }),
    ),
  );

  it.effect("restarts a completed worker within a bounded recovery budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const events = yield* Queue.unbounded<string>();
        const supervisor = yield* Effect.forkScoped(
          superviseCloudSyncCompanies({
            discover: () => Effect.succeed([COMPANY_A]),
            runCompany: () =>
              Effect.gen(function* () {
                const attempt = yield* Ref.updateAndGet(attempts, (value) => value + 1);
                yield* Queue.offer(events, `start:${attempt}`);
                if (attempt === 1) return;
                yield* Effect.acquireRelease(Effect.void, () =>
                  Queue.offer(events, `stop:${attempt}`),
                );
                return yield* Effect.never;
              }),
            workerLabel: "test-recovery",
            reconcileInterval: "1 hour",
            workerRestartDelay: 0,
            workerRestarts: 2,
          }),
        );

        expect(yield* Queue.take(events)).toBe("start:1");
        expect(yield* Queue.take(events)).toBe("start:2");
        yield* Fiber.interrupt(supervisor);
        expect(yield* Queue.take(events)).toBe("stop:2");
      }),
    ),
  );

  it.effect("bounds each restart burst and retries on a later reconciliation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const events = yield* Queue.unbounded<number>();
        const listings = yield* Queue.unbounded<ReadonlyArray<CompanyId>>();
        yield* Queue.offer(listings, [COMPANY_A]);
        const supervisor = yield* Effect.forkScoped(
          superviseCloudSyncCompanies({
            discover: () => Queue.take(listings),
            runCompany: () =>
              Ref.updateAndGet(attempts, (value) => value + 1).pipe(
                Effect.flatMap((attempt) => Queue.offer(events, attempt)),
                Effect.asVoid,
              ),
            workerLabel: "test-budget",
            reconcileInterval: 0,
            workerRestartDelay: 0,
            workerRestarts: 2,
          }),
        );

        expect([
          yield* Queue.take(events),
          yield* Queue.take(events),
          yield* Queue.take(events),
        ]).toEqual([1, 2, 3]);
        yield* Queue.offer(listings, [COMPANY_A]);
        expect([
          yield* Queue.take(events),
          yield* Queue.take(events),
          yield* Queue.take(events),
        ]).toEqual([4, 5, 6]);
        yield* Fiber.interrupt(supervisor);
      }),
    ),
  );

  it.effect("interrupting the supervisor closes every company worker scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<string>();
        const runCompany = (companyId: CompanyId) =>
          Effect.acquireRelease(Queue.offer(events, `start:${companyId}`), () =>
            Queue.offer(events, `stop:${companyId}`),
          ).pipe(Effect.andThen(Effect.never));
        const supervisor = yield* Effect.forkScoped(
          superviseCloudSyncCompanies({
            discover: () => Effect.succeed([COMPANY_A, COMPANY_B]),
            runCompany,
            workerLabel: "test-ownership",
          }),
        );

        expect(new Set([yield* Queue.take(events), yield* Queue.take(events)])).toEqual(
          new Set([`start:${COMPANY_A}`, `start:${COMPANY_B}`]),
        );
        yield* Fiber.interrupt(supervisor);
        expect(new Set([yield* Queue.take(events), yield* Queue.take(events)])).toEqual(
          new Set([`stop:${COMPANY_A}`, `stop:${COMPANY_B}`]),
        );
      }),
    ),
  );
});
