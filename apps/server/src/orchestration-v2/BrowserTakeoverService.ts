import {
  CommandId,
  MessageId,
  type OrchestrationV2BrowserTakeoverFailure,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  PreviewAutomationActivitySink,
  PreviewAutomationTakeoverFence,
  PreviewTakeoverFenceError,
  type PreviewTakeoverLease,
} from "../mcp/PreviewAutomationTakeover.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import { isTerminalRunStatus, ThreadManagementService } from "./ThreadManagementService.ts";

/**
 * The automation fence as orchestration sees it: thread-scoped, with the
 * environment already bound.
 */
export interface BrowserTakeoverRearmInput {
  readonly threadId: ThreadId;
  readonly takeoverId: CommandId;
  readonly hostClientId: string | null;
  readonly hostConnectionId: string | null;
  readonly tabId: string | null;
}

export interface BrowserTakeoverFenceShape {
  readonly acquire: (input: {
    readonly threadId: ThreadId;
    readonly takeoverId: CommandId;
    readonly drainTimeoutMs?: number;
  }) => Effect.Effect<PreviewTakeoverLease, PreviewTakeoverFenceError>;
  readonly release: (input: {
    readonly threadId: ThreadId;
    readonly takeoverId: CommandId;
  }) => Effect.Effect<void>;
  readonly rearm: (input: BrowserTakeoverRearmInput) => Effect.Effect<void>;
}

export const unavailableBrowserTakeoverFence: BrowserTakeoverFenceShape = {
  acquire: (input) =>
    Effect.fail(
      new PreviewTakeoverFenceError({
        reason: "no_live_host",
        threadId: input.threadId,
        takeoverId: input.takeoverId,
      }),
    ),
  release: () => Effect.void,
  rearm: () => Effect.void,
};

/**
 * Late binding for the automation fence.
 *
 * Orchestration and the preview automation broker genuinely depend on each
 * other: the broker publishes activity into orchestration (through the sink),
 * and orchestration fences the broker during a takeover. A layer cycle cannot
 * express that, and making the fence a layer requirement would push a broker
 * dependency through every graph that builds orchestration — including the CLI.
 * So the composition root that builds both registers the live fence here at
 * startup. Until it does, the registry answers "no live host", which is the
 * honest result for a runtime with no preview automation attached.
 */
export interface BrowserTakeoverFenceRegistryShape {
  readonly current: Effect.Effect<BrowserTakeoverFenceShape>;
  readonly set: (fence: BrowserTakeoverFenceShape) => Effect.Effect<void>;
}

export class BrowserTakeoverFenceRegistry extends Context.Service<
  BrowserTakeoverFenceRegistry,
  BrowserTakeoverFenceRegistryShape
>()("t3/orchestration-v2/BrowserTakeoverService/BrowserTakeoverFenceRegistry") {}

export const fenceRegistryLayer = Layer.effect(
  BrowserTakeoverFenceRegistry,
  Effect.gen(function* () {
    const held = yield* Ref.make<BrowserTakeoverFenceShape | null>(null);
    const pendingRearms = yield* Ref.make<ReadonlyArray<BrowserTakeoverRearmInput>>([]);
    // Startup recovery and the broker layer build are not ordered relative to
    // each other, so a re-arm can land before the live fence is registered.
    // Dropping it would leave a thread the user is still holding open to
    // automation, so the pre-registration fence queues re-arms and `set`
    // replays them into the real fence.
    const bufferingFence: BrowserTakeoverFenceShape = {
      acquire: unavailableBrowserTakeoverFence.acquire,
      release: () => Effect.void,
      rearm: (input) => Ref.update(pendingRearms, (queued) => [...queued, input]),
    };
    return BrowserTakeoverFenceRegistry.of({
      current: Ref.get(held).pipe(Effect.map((fence) => fence ?? bufferingFence)),
      set: (fence) =>
        Effect.gen(function* () {
          yield* Ref.set(held, fence);
          const queued = yield* Ref.getAndSet(pendingRearms, []);
          yield* Effect.forEach(queued, (input) => fence.rearm(input), { discard: true });
        }),
    });
  }),
);

/**
 * Binds the durable takeover state machine to the live preview automation
 * fence. Run once at startup from the composition root that builds the broker,
 * so both sides share one fence.
 */
export const registerPreviewAutomationFence: Effect.Effect<
  void,
  never,
  BrowserTakeoverFenceRegistry | PreviewAutomationTakeoverFence | ServerEnvironment
> = Effect.gen(function* () {
  const registry = yield* BrowserTakeoverFenceRegistry;
  const fence = yield* PreviewAutomationTakeoverFence;
  const environment = yield* ServerEnvironment;
  yield* registry.set({
    acquire: (input) =>
      environment.getEnvironmentId.pipe(
        Effect.flatMap((environmentId) => fence.acquire({ environmentId, ...input })),
      ),
    release: (input) =>
      environment.getEnvironmentId.pipe(
        Effect.flatMap((environmentId) => fence.release({ environmentId, ...input })),
      ),
    rearm: (input) =>
      environment.getEnvironmentId.pipe(
        Effect.flatMap((environmentId) => fence.rearm({ environmentId, ...input })),
      ),
  });
});

/**
 * Sent as the user when a takeover is handed back. The wording is deliberately
 * explicit about *where* the state lives (the current Preview tab) because the
 * agent cannot see what the human did while it was paused.
 */
export const BROWSER_TAKEOVER_CONTINUATION_TEXT =
  "I’ve finished configuring the browser and it is ready in the current Preview tab. Continue from the browser’s current state.";

/**
 * How long the fence waits for in-flight automation to settle before reporting
 * a drain failure. Generous: a stuck request is far less bad than handing the
 * user a browser the agent is still driving.
 */
const FENCE_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Bound on waiting for the interrupted run to reach a terminal (or draining)
 * status. Long enough to cover a provider that shuts a turn down slowly, short
 * enough that a wedged provider still surfaces as a failed takeover instead of
 * a spinner forever.
 */
const RUN_TERMINAL_TIMEOUT_MS = 60_000;
const RUN_TERMINAL_POLL_INTERVAL_MS = 25;

export interface BrowserTakeoverStepInput {
  readonly threadId: ThreadId;
  readonly takeoverId: CommandId;
  /**
   * The command that enqueued this step. Derived command ids hang off it rather
   * than off `takeoverId` so a retried step (a second proceed after a failed
   * continuation) gets fresh ids instead of colliding with the previous
   * attempt's command receipts.
   */
  readonly attemptId: CommandId;
}

export interface BrowserTakeoverRecoverySummary {
  readonly failed: number;
  readonly rearmed: number;
  readonly completed: number;
}

export interface BrowserTakeoverServiceShape {
  readonly establish: (input: BrowserTakeoverStepInput) => Effect.Effect<void, OrchestratorV2Error>;
  readonly proceed: (input: BrowserTakeoverStepInput) => Effect.Effect<void, OrchestratorV2Error>;
  readonly release: (input: BrowserTakeoverStepInput) => Effect.Effect<void, OrchestratorV2Error>;
  /**
   * Reconciles takeover markers that outlived the process. Runs once at
   * startup, next to the other orchestration recovery passes.
   */
  readonly recover: Effect.Effect<BrowserTakeoverRecoverySummary, OrchestratorV2Error>;
}

export class BrowserTakeoverService extends Context.Service<
  BrowserTakeoverService,
  BrowserTakeoverServiceShape
>()("t3/orchestration-v2/BrowserTakeoverService") {}

/** The message a proceed attempt sends. Deterministic so recovery can find it. */
function continuationMessageIdPrefix(takeoverId: CommandId): string {
  return `message:browser-takeover:${takeoverId}:`;
}

function continuationMessageId(input: BrowserTakeoverStepInput): MessageId {
  return MessageId.make(`${continuationMessageIdPrefix(input.takeoverId)}${input.attemptId}`);
}

function hasContinuationMessage(
  projection: OrchestrationV2ThreadProjection,
  takeoverId: CommandId,
): boolean {
  const prefix = continuationMessageIdPrefix(takeoverId);
  return projection.messages.some((message) => message.id.startsWith(prefix));
}

function fenceFailureReason(
  error: PreviewTakeoverFenceError,
): Extract<
  OrchestrationV2BrowserTakeoverFailure,
  "no_live_host" | "host_disconnected" | "fence_failed"
> {
  switch (error.reason) {
    case "no_live_host":
      return "no_live_host";
    case "host_disconnected":
      return "host_disconnected";
    case "drain_failed":
      return "fence_failed";
  }
}

type StepOutcome =
  | { readonly type: "done" }
  | { readonly type: "failed"; readonly failure: OrchestrationV2BrowserTakeoverFailure };

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const fenceRegistry = yield* BrowserTakeoverFenceRegistry;
  // Resolved per call, not captured: the live fence is registered after this
  // layer is built.
  const fence: BrowserTakeoverFenceShape = {
    acquire: (input) => Effect.flatMap(fenceRegistry.current, (current) => current.acquire(input)),
    release: (input) => Effect.flatMap(fenceRegistry.current, (current) => current.release(input)),
    rearm: (input) => Effect.flatMap(fenceRegistry.current, (current) => current.rearm(input)),
  };

  const loadMarker = (input: {
    readonly threadId: ThreadId;
    readonly takeoverId: CommandId;
  }) =>
    Effect.gen(function* () {
      const projection = yield* threads.getThreadProjection(input.threadId);
      const marker = projection.thread.browserTakeover ?? null;
      // A marker naming a different takeover means this step lost a race with a
      // newer request; there is nothing left for it to move.
      return marker === null || marker.id !== input.takeoverId
        ? null
        : ({ marker, projection } as const);
    });

  /**
   * Every transition is fenced by the takeover id in the decider, so a stale
   * step is rejected there rather than corrupting a newer takeover. Losing that
   * race is expected, not an error: log and stop.
   */
  const transition = (input: {
    readonly threadId: ThreadId;
    readonly takeoverId: CommandId;
    readonly attemptId: CommandId;
    readonly step: string;
    readonly to: "pausing" | "active" | "completed" | "cancelled" | "failed";
    readonly failure?: OrchestrationV2BrowserTakeoverFailure;
    readonly hostClientId?: string | null;
    readonly hostConnectionId?: string | null;
    readonly tabId?: string | null;
  }) =>
    threads
      .dispatch({
        type: "thread.browser-takeover.transition",
        commandId: CommandId.make(`${input.attemptId}:${input.step}`),
        threadId: input.threadId,
        takeoverId: input.takeoverId,
        to: input.to,
        ...(input.failure === undefined ? {} : { failure: input.failure }),
        ...(input.hostClientId === undefined ? {} : { hostClientId: input.hostClientId }),
        ...(input.hostConnectionId === undefined
          ? {}
          : { hostConnectionId: input.hostConnectionId }),
        ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
      })
      .pipe(
        Effect.as(true),
        Effect.catchTag("OrchestratorBrowserTakeoverStaleError", (error) =>
          Effect.logDebug("Skipping stale browser takeover transition", {
            threadId: input.threadId,
            takeoverId: input.takeoverId,
            to: input.to,
            detail: error.detail,
          }).pipe(Effect.as(false)),
        ),
      );

  const failStep = (input: BrowserTakeoverStepInput, failure: OrchestrationV2BrowserTakeoverFailure) =>
    transition({ ...input, step: "takeover-failed", to: "failed", failure }).pipe(Effect.asVoid);

  /**
   * Wraps a step so an unexpected defect still lands the marker in a terminal
   * state: a takeover stuck at "pausing" would leave the user staring at a
   * spinner with no way out.
   */
  const runStep = (
    input: BrowserTakeoverStepInput,
    label: string,
    fallback: OrchestrationV2BrowserTakeoverFailure,
    step: Effect.Effect<StepOutcome, OrchestratorV2Error>,
  ) =>
    Effect.gen(function* () {
      const outcome = yield* step.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning(`${label} failed`, {
                threadId: input.threadId,
                takeoverId: input.takeoverId,
                cause,
              }).pipe(Effect.as({ type: "failed", failure: fallback } as const)),
        ),
      );
      if (outcome.type === "done") return;
      yield* failStep(input, outcome.failure);
    });

  const awaitRunSettled = (input: { readonly threadId: ThreadId; readonly runId: string }) =>
    Effect.gen(function* () {
      // Poll the projection rather than sleeping a fixed budget: the interrupt
      // lands as a domain event, and the takeover must not report control until
      // the provider turn is actually over.
      while (true) {
        const projection = yield* threads.getThreadProjection(input.threadId);
        const run = projection.runs.find((candidate) => candidate.id === input.runId);
        if (run === undefined || isTerminalRunStatus(run.status) || run.status === "waiting") {
          return true;
        }
        yield* Effect.sleep(Duration.millis(RUN_TERMINAL_POLL_INTERVAL_MS));
      }
    }).pipe(
      Effect.timeoutOption(Duration.millis(RUN_TERMINAL_TIMEOUT_MS)),
      Effect.map(Option.getOrElse(() => false)),
    );

  const establishStep = (
    input: BrowserTakeoverStepInput,
  ): Effect.Effect<StepOutcome, OrchestratorV2Error> =>
    Effect.gen(function* () {
      const loaded = yield* loadMarker(input);
      if (loaded === null || loaded.marker.status !== "requested") {
        return { type: "done" } as const;
      }
      if (!(yield* transition({ ...input, step: "takeover-pausing", to: "pausing" }))) {
        return { type: "done" } as const;
      }

      const acquired = yield* fence
        .acquire({
          threadId: input.threadId,
          takeoverId: input.takeoverId,
          drainTimeoutMs: FENCE_DRAIN_TIMEOUT_MS,
        })
        .pipe(Effect.result);
      if (acquired._tag === "Failure") {
        const failure = fenceFailureReason(acquired.failure);
        // The fence stays armed on every failure *except* "no live host", where
        // there was never anything to fence: keeping automation blocked after a
        // half-finished takeover is the safe default, and the user can always
        // release. Releasing on a drain failure would hand the browser back
        // while a straggler request is still in flight.
        if (failure === "no_live_host") {
          yield* fence.release({
            threadId: input.threadId,
            takeoverId: input.takeoverId,
          });
        }
        return { type: "failed", failure } as const;
      }
      const lease = acquired.success;

      const projection = yield* threads.getThreadProjection(input.threadId);
      const run = projection.runs.find((candidate) => candidate.id === loaded.marker.runId);
      // "waiting" counts as finished here for the same reason it does not count
      // as eligible in the decider: the provider turn is already over, so there
      // is nothing left to pause and the user should be told so.
      if (run === undefined || isTerminalRunStatus(run.status) || run.status === "waiting") {
        yield* fence.release({
          threadId: input.threadId,
          takeoverId: input.takeoverId,
        });
        return { type: "failed", failure: "already_finished" } as const;
      }

      const interrupted = yield* threads
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`${input.attemptId}:takeover-interrupt`),
          threadId: input.threadId,
          runId: loaded.marker.runId,
          reason: "Paused so the user can drive the browser.",
        })
        .pipe(Effect.result);
      if (interrupted._tag === "Failure") {
        yield* Effect.logWarning("Browser takeover could not interrupt the run", {
          threadId: input.threadId,
          takeoverId: input.takeoverId,
          cause: interrupted.failure,
        });
        return { type: "failed", failure: "interrupt_failed" } as const;
      }
      if (!(yield* awaitRunSettled({ threadId: input.threadId, runId: loaded.marker.runId }))) {
        return { type: "failed", failure: "interrupt_failed" } as const;
      }

      yield* transition({
        ...input,
        step: "takeover-active",
        to: "active",
        hostClientId: lease.hostClientId,
        hostConnectionId: lease.hostConnectionId,
        tabId: lease.tabId,
      });
      return { type: "done" } as const;
    });

  const proceedStep = (
    input: BrowserTakeoverStepInput,
  ): Effect.Effect<StepOutcome, OrchestratorV2Error> =>
    Effect.gen(function* () {
      const loaded = yield* loadMarker(input);
      if (loaded === null || loaded.marker.status !== "proceeding") {
        return { type: "done" } as const;
      }
      // Release first: the agent's next turn needs automation back, and release
      // is idempotent, so a retry after a failed send cannot double-release.
      yield* fence.release({
        threadId: input.threadId,
        takeoverId: input.takeoverId,
      });

      const sent = yield* threads
        .sendToThread({
          projectId: loaded.projection.thread.projectId,
          commandId: CommandId.make(`${input.attemptId}:takeover-continuation`),
          threadId: input.threadId,
          messageId: continuationMessageId(input),
          text: BROWSER_TAKEOVER_CONTINUATION_TEXT,
          attachments: [],
          // The paused run is terminal by now, so "auto" starts a fresh turn
          // immediately rather than steering or queueing behind anything.
          mode: "auto",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.result);
      if (sent._tag === "Failure") {
        yield* Effect.logWarning("Browser takeover continuation could not be sent", {
          threadId: input.threadId,
          takeoverId: input.takeoverId,
          cause: sent.failure,
        });
        return { type: "failed", failure: "continuation_failed" } as const;
      }

      yield* transition({ ...input, step: "takeover-completed", to: "completed" });
      return { type: "done" } as const;
    });

  const releaseStep = (
    input: BrowserTakeoverStepInput,
  ): Effect.Effect<StepOutcome, OrchestratorV2Error> =>
    Effect.gen(function* () {
      const loaded = yield* loadMarker(input);
      if (loaded === null || loaded.marker.status === "cancelled") {
        return { type: "done" } as const;
      }
      yield* fence.release({
        threadId: input.threadId,
        takeoverId: input.takeoverId,
      });
      yield* transition({ ...input, step: "takeover-cancelled", to: "cancelled" });
      return { type: "done" } as const;
    });

  const recover = Effect.gen(function* () {
    const shell = yield* threads.getShellSnapshot();
    let failed = 0;
    let rearmed = 0;
    let completed = 0;
    for (const summary of [...shell.threads, ...shell.archivedThreads]) {
      const projection = yield* threads.getThreadProjection(summary.id);
      const marker = projection.thread.browserTakeover ?? null;
      if (marker === null) continue;
      const step = {
        threadId: summary.id,
        takeoverId: marker.id,
        attemptId: CommandId.make(`${marker.id}:takeover-recovery`),
      } satisfies BrowserTakeoverStepInput;
      switch (marker.status) {
        case "requested":
        case "pausing": {
          // Nothing was ever handed over: the fence died with the process, so
          // the honest report is that the takeover did not survive.
          yield* transition({
            ...step,
            step: "takeover-failed",
            to: "failed",
            failure: "server_restarted",
          });
          failed += 1;
          break;
        }
        case "active": {
          // The user is holding the browser right now. Re-arm from the captured
          // host/tab so automation stays blocked across the restart.
          yield* fence.rearm({
            threadId: summary.id,
            takeoverId: marker.id,
            hostClientId: marker.hostClientId,
            hostConnectionId: marker.hostConnectionId,
            tabId: marker.tabId,
          });
          rearmed += 1;
          break;
        }
        case "proceeding": {
          // The continuation either landed before the restart or never will.
          if (hasContinuationMessage(projection, marker.id)) {
            yield* transition({ ...step, step: "takeover-completed", to: "completed" });
            completed += 1;
          } else {
            yield* transition({
              ...step,
              step: "takeover-failed",
              to: "failed",
              failure: "continuation_failed",
            });
            failed += 1;
          }
          break;
        }
        case "completed":
        case "cancelled":
        case "failed":
          break;
      }
    }
    return { failed, rearmed, completed } satisfies BrowserTakeoverRecoverySummary;
  });

  return BrowserTakeoverService.of({
    establish: (input) =>
      runStep(input, "Browser takeover establish", "fence_failed", establishStep(input)),
    proceed: (input) =>
      runStep(input, "Browser takeover proceed", "continuation_failed", proceedStep(input)),
    release: (input) =>
      runStep(input, "Browser takeover release", "fence_failed", releaseStep(input)),
    recover,
  });
});

export const layer = Layer.effect(BrowserTakeoverService, make);

/**
 * Publishes the broker's coalesced preview activity into orchestration. Provided
 * where the broker layer is built so the broker keeps depending only on the
 * seam.
 */
export const activitySinkLayer: Layer.Layer<
  never,
  never,
  ThreadManagementService | Crypto.Crypto
> = Layer.effect(
  PreviewAutomationActivitySink,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const crypto = yield* Crypto.Crypto;
    return {
      record: (record) =>
        Effect.gen(function* () {
          const commandId = yield* crypto.randomUUIDv4;
          yield* threads.dispatch({
            type: "thread.preview-activity.record",
            commandId: CommandId.make(`command:preview-activity:${commandId}`),
            threadId: record.threadId,
            // The broker cannot know which run is live; the decider derives the
            // run from the projection and ignores this hint.
            runId: null,
            providerSessionId: record.providerSessionId,
            tabId: record.tabId,
            hostClientId: record.hostClientId,
          });
        }).pipe(
          // An unchanged tuple is rejected by the decider so it writes no event.
          // That is the common case for a re-observed host, not a problem.
          Effect.catchCause((cause) =>
            Effect.logDebug("Preview activity was not recorded", {
              threadId: record.threadId,
              cause,
            }),
          ),
        ),
    };
  }),
);
