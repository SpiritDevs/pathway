/** Queue hints avoid idle claims; timed recovery still handles lease clocks and older deployments. */
import type { CompanyId } from "@spiritdevs/contracts/company";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";

export type WorkerQueue = "commands" | "mail" | "reasoning" | "inspections" | "results";
const pendingRef = makeFunctionReference<
  "query",
  { companyId: string; kind: WorkerQueue },
  boolean
>("workerWakeups:pending");

/** A sliding wakeup survives work in progress without accumulating a backlog of claims. */
export const makeWorkerWakeupGate = Effect.fn("cloud.worker_wakeup.gate")(function* (
  activeRecoveryMs = 10_000,
) {
  const queue = yield* Queue.sliding<void>(1);
  let pending = true;
  return {
    notify: (value: boolean) => {
      pending = value;
      if (value) Queue.offerUnsafe(queue, undefined);
    },
    wait: Effect.suspend(() =>
      Queue.take(queue).pipe(
        Effect.timeoutOption(pending ? activeRecoveryMs : 60_000),
        Effect.asVoid,
      ),
    ),
  };
});

export const makeWorkerWakeups = Effect.fn("cloud.worker_wakeup.subscribe")(function* <
  K extends WorkerQueue,
>(input: {
  readonly convexUrl: string;
  readonly companyId: CompanyId;
  readonly tokens: ConvexServiceTokenProvider;
  readonly kinds: readonly K[];
  readonly client?: Pick<ConvexClient, "setAuth" | "onUpdate" | "close">;
}) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => input.client ?? new ConvexClient(input.convexUrl)),
    (convex) => Effect.promise(() => convex.close()),
  );
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  client.setAuth(({ forceRefreshToken }) =>
    runPromise(
      (forceRefreshToken ? input.tokens.invalidate() : Effect.void).pipe(
        Effect.andThen(input.tokens.token),
      ),
    ),
  );
  const gates = new Map<K, Effect.Effect<void>>();
  for (const kind of input.kinds) {
    const gate = yield* makeWorkerWakeupGate(kind === "commands" ? 5_000 : 10_000);
    gates.set(kind, gate.wait);
    yield* Stream.callback<boolean, unknown>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            client.onUpdate(
              pendingRef,
              { companyId: input.companyId, kind },
              (pending) => Queue.offerUnsafe(queue, pending),
              (error) => {
                gate.notify(true);
                Queue.failCauseUnsafe(queue, Cause.fail(error));
              },
            ),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        ).pipe(Effect.asVoid),
      { bufferSize: 1, strategy: "sliding" },
    ).pipe(
      Stream.retry(Schedule.spaced("10 seconds")),
      Stream.runForEach((value) => Effect.sync(() => gate.notify(value))),
      Effect.forkScoped,
    );
  }
  return { wait: (kind: K) => gates.get(kind)! };
});
