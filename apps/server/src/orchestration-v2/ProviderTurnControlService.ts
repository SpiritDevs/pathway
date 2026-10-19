import {
  MessageId,
  CommandId,
  type OrchestrationV2DomainEvent,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { QuestionAnswerDelivery } from "./QuestionAnswerDelivery.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { makeInterruptResultTurnItem } from "./RunExecutionService.ts";
import * as DateTime from "effect/DateTime";

// How long a provider gets to acknowledge an interrupt. Past it, Stop forces the
// interrupted state and restart fails so its durable effect can retry.
const providerTerminalDeadline = Duration.seconds(5);

export class ProviderTurnControlError extends Schema.TaggedErrorClass<ProviderTurnControlError>()(
  "ProviderTurnControlError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["interrupt", "restart", "steer"]),
    providerTurnId: ProviderTurnId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnControlError = Schema.is(ProviderTurnControlError);

export interface ProviderTurnControlServiceV2Shape {
  readonly interrupt: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  readonly steer: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly messageId: MessageId;
    readonly answerCommandId?: CommandId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  readonly interruptAndAwaitTerminal: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly replacementProviderSessionId?: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly interruptedAttemptId: RunAttemptId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
}

export class ProviderTurnControlServiceV2 extends Context.Service<
  ProviderTurnControlServiceV2,
  ProviderTurnControlServiceV2Shape
>()(
  "@spiritdevs/pathway/orchestration-v2/ProviderTurnControlService/ProviderTurnControlServiceV2",
) {}

export const layer: Layer.Layer<
  ProviderTurnControlServiceV2,
  never,
  EventSinkV2 | IdAllocatorV2 | ProjectionStoreV2 | ProviderSessionManagerV2
> = Layer.effect(
  ProviderTurnControlServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const questionDelivery = yield* Effect.serviceOption(QuestionAnswerDelivery);

    /**
     * Waits until the provider turn, and the attempt when given, leave "running". It reads
     * only this thread's events after `afterSequence`; callers capture that before loading
     * the state they pass in, so a terminal event landing in between is replayed, not missed.
     * Returns false when the deadline passes first.
     */
    const awaitTerminal = Effect.fn("ProviderTurnControlService.awaitTerminal")(function* (input: {
      readonly threadId: ThreadId;
      readonly afterSequence: number;
      readonly providerTurnId: ProviderTurnId;
      readonly attempt?: { readonly id: RunAttemptId; readonly settled: boolean };
    }) {
      let turnSettled = false;
      let attemptSettled = input.attempt?.settled ?? true;
      const finished = yield* eventSink
        .stream({ threadId: input.threadId, afterSequence: input.afterSequence })
        .pipe(
          Stream.takeUntil(({ event }) => {
            if (event.type === "provider-turn.updated" && event.payload.id === input.providerTurnId)
              turnSettled = event.payload.status !== "running";
            if (event.type === "run-attempt.updated" && event.payload.id === input.attempt?.id)
              attemptSettled = event.payload.status !== "running";
            return turnSettled && attemptSettled;
          }),
          Stream.runDrain,
          Effect.timeoutOption(providerTerminalDeadline),
        );
      return Option.isSome(finished);
    });

    const forceInterruptedTerminal = Effect.fn(
      "ProviderTurnControlService.forceInterruptedTerminal",
    )(function* (input: { readonly threadId: ThreadId; readonly providerTurnId: ProviderTurnId }) {
      const projection = yield* projections.getThreadProjection(input.threadId);
      const providerTurn = projection.providerTurns.find(
        (candidate) => candidate.id === input.providerTurnId,
      );
      if (providerTurn === undefined || providerTurn.status !== "running") return;
      const attempt = projection.attempts.find(
        (candidate) => candidate.id === providerTurn.runAttemptId,
      );
      const run = projection.runs.find((candidate) => candidate.id === attempt?.runId);
      const rootNode = projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === providerTurn.providerThreadId,
      );
      if (
        attempt === undefined ||
        run === undefined ||
        rootNode === undefined ||
        providerThread === undefined ||
        run.status !== "running" ||
        run.activeAttemptId !== attempt.id
      ) {
        yield* Effect.logWarning(
          "Provider stayed running after interrupt but its owning run is no longer current",
          {
            threadId: input.threadId,
            providerTurnId: input.providerTurnId,
          },
        );
        return;
      }
      const now = yield* DateTime.now;
      const events: Array<OrchestrationV2DomainEvent> = [];
      const append = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
        ids.allocate
          .event({ threadId: event.threadId })
          .pipe(Effect.map((id) => events.push({ ...event, id } as Event)));

      yield* append({
        type: "provider-turn.updated",
        threadId: input.threadId,
        runId: run.id,
        nodeId: providerTurn.nodeId,
        occurredAt: now,
        payload: { ...providerTurn, status: "interrupted", completedAt: now },
      });
      yield* append({
        type: "run-attempt.updated",
        threadId: input.threadId,
        runId: run.id,
        nodeId: attempt.rootNodeId,
        providerInstanceId: attempt.providerInstanceId,
        occurredAt: now,
        payload: { ...attempt, status: "interrupted", completedAt: now },
      });
      for (const node of projection.nodes.filter(
        (candidate) =>
          candidate.runId === run.id &&
          (candidate.status === "pending" ||
            candidate.status === "running" ||
            candidate.status === "waiting"),
      )) {
        yield* append({
          type: "node.updated",
          threadId: input.threadId,
          runId: run.id,
          nodeId: node.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: "interrupted", completedAt: now },
        });
      }
      const hasInterruptRequest = projection.turnItems.some(
        (item) => item.runId === run.id && item.type === "run_interrupt_request",
      );
      const hasInterruptResult = projection.turnItems.some(
        (item) => item.runId === run.id && item.type === "run_interrupt_result",
      );
      if (hasInterruptRequest && !hasInterruptResult) {
        yield* append({
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: makeInterruptResultTurnItem({
            idAllocator: ids,
            run,
            rootNode,
            providerThread,
            completedAt: now,
          }),
        });
      }
      yield* append({
        type: "run.updated",
        threadId: input.threadId,
        runId: run.id,
        ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, status: "interrupted", queuePosition: null, completedAt: now },
      });
      yield* Effect.logWarning(
        "Provider did not terminalize after interrupt; forcing terminal state",
        {
          threadId: input.threadId,
          providerTurnId: input.providerTurnId,
          runId: run.id,
        },
      );
      yield* eventSink.writeIfRunCurrent({
        threadId: input.threadId,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "running",
        events,
      });
    });

    const load = (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly replacementProviderSessionId?: ProviderSessionId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly operation: "interrupt" | "restart" | "steer";
    }) =>
      Effect.gen(function* () {
        const projection = yield* projections.getThreadProjection(input.threadId);
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === input.providerThreadId,
        );
        const providerTurn = projection.providerTurns.find(
          (candidate) => candidate.id === input.providerTurnId,
        );
        const targetsRecordedSession =
          providerThread?.providerSessionId === input.providerSessionId;
        const targetsCommittedReplacement =
          input.operation === "restart" &&
          input.replacementProviderSessionId !== undefined &&
          providerThread?.providerSessionId === input.replacementProviderSessionId;
        if (
          providerThread === undefined ||
          providerTurn === undefined ||
          (!targetsRecordedSession && !targetsCommittedReplacement) ||
          providerTurn.providerThreadId !== providerThread.id
        ) {
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: input.operation,
            providerTurnId: input.providerTurnId,
            cause: "The recorded provider execution target is no longer valid.",
          });
        }
        // A restart-session command commits the replacement binding before its
        // process-bound effect runs. The old live runtime must still receive
        // the interrupt, but only when the projection matches the exact
        // replacement captured by that same durable effect.
        const interruptProviderThread = targetsRecordedSession
          ? providerThread
          : { ...providerThread, providerSessionId: input.providerSessionId };
        if (providerTurn.status !== "running") {
          return {
            projection,
            providerThread: interruptProviderThread,
            providerTurn,
            session: Option.none(),
          };
        }
        const session = yield* sessions.get(input.providerSessionId);
        if (Option.isNone(session)) {
          // Interrupt/restart against a already-released session must not fail
          // the durable effect (and retry 5x). The turn may still look running
          // in projection until recovery/finalization; there is no live adapter
          // to interrupt.
          if (input.operation === "interrupt" || input.operation === "restart") {
            yield* Effect.logWarning(
              "Provider interrupt/restart found no live session; treating as already stopped",
              {
                threadId: input.threadId,
                operation: input.operation,
                providerSessionId: input.providerSessionId,
                providerTurnId: input.providerTurnId,
                providerTurnStatus: providerTurn.status,
              },
            );
            return {
              projection,
              providerThread: interruptProviderThread,
              providerTurn,
              session: Option.none(),
            };
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: input.operation,
            providerTurnId: input.providerTurnId,
            cause: `Provider session ${input.providerSessionId} is not active.`,
          });
        }
        return { projection, providerThread: interruptProviderThread, providerTurn, session };
      });

    return ProviderTurnControlServiceV2.of({
      interrupt: (input) =>
        Effect.gen(function* () {
          const afterSequence = yield* eventSink.latestSequence({ threadId: input.threadId });
          const loaded = yield* load({ ...input, operation: "interrupt" });
          if (Option.isNone(loaded.session)) return;
          yield* loaded.session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
            requestRuntimeRestart: true,
          });
          const settled = yield* awaitTerminal({
            threadId: input.threadId,
            afterSequence,
            providerTurnId: input.providerTurnId,
          });
          if (!settled) {
            yield* forceInterruptedTerminal({
              threadId: input.threadId,
              providerTurnId: input.providerTurnId,
            });
          }
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "interrupt",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
      interruptAndAwaitTerminal: (input) =>
        Effect.gen(function* () {
          const afterSequence = yield* eventSink.latestSequence({ threadId: input.threadId });
          const loaded = yield* load({ ...input, operation: "restart" });
          if (Option.isNone(loaded.session)) {
            // No live adapter: nothing can emit a terminal provider-turn update
            // from interrupt. Do not poll for projection terminalization or the
            // restart effect stalls; let detach/start proceed.
            if (loaded.providerTurn.status === "running") {
              yield* Effect.logWarning(
                "Provider restart interrupt skipped; no live session for a still-projected running turn",
                {
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  providerTurnId: input.providerTurnId,
                },
              );
            }
            return;
          }

          yield* loaded.session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
          });

          const attempt = loaded.projection.attempts.find(
            (candidate) => candidate.id === input.interruptedAttemptId,
          );
          const settled = yield* awaitTerminal({
            threadId: input.threadId,
            afterSequence,
            providerTurnId: input.providerTurnId,
            attempt: {
              id: input.interruptedAttemptId,
              settled: attempt !== undefined && attempt.status !== "running",
            },
          });
          if (settled) return;
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "restart",
            providerTurnId: input.providerTurnId,
            cause: `Provider turn ${input.providerTurnId} did not terminalize before restart.`,
          });
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "restart",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
      steer: (input) =>
        Effect.gen(function* () {
          const loaded = yield* load({ ...input, operation: "steer" });
          const isQuestionAnswer = loaded.projection.runtimeRequests.some(
            (request) =>
              request.responseMessageId === input.messageId &&
              request.responseCapability.type === "message",
          );
          const followUp = () =>
            Option.isSome(questionDelivery) && input.answerCommandId !== undefined
              ? questionDelivery.value
                  .followUp({
                    threadId: input.threadId,
                    providerThreadId: input.providerThreadId,
                    messageId: input.messageId,
                    commandId: input.answerCommandId,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderTurnControlError({
                          threadId: input.threadId,
                          providerTurnId: input.providerTurnId,
                          operation: "steer",
                          cause,
                        }),
                    ),
                  )
              : Effect.fail(
                  new ProviderTurnControlError({
                    threadId: input.threadId,
                    providerTurnId: input.providerTurnId,
                    operation: "steer",
                    cause: "The turn completed before the question answer could be delivered.",
                  }),
                );
          if (Option.isNone(loaded.session)) {
            if (isQuestionAnswer) yield* followUp();
            return;
          }

          const message = loaded.projection.messages.find(
            (candidate) => candidate.id === input.messageId,
          );
          const run = loaded.projection.runs.find(
            (candidate) => candidate.activeAttemptId === loaded.providerTurn.runAttemptId,
          );
          const isNativeQuestionAnswer =
            isQuestionAnswer && loaded.providerTurn.runAttemptId === null;
          if (message === undefined || (run === undefined && !isNativeQuestionAnswer)) {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              cause: "The persisted steering message or target run is missing.",
            });
          }
          yield* loaded.session.value
            .steerTurn({
              threadId: input.threadId,
              runId: run?.id ?? null,
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              message: {
                messageId: message.id,
                text: message.text,
                attachments: message.attachments,
                createdBy: message.createdBy,
                creationSource: message.creationSource,
              },
            })
            .pipe(
              Effect.catch((cause) => {
                const detail = Cause.pretty(Cause.fail(cause));
                return isQuestionAnswer &&
                  /is not active and cannot be steered|no active turn|expected.*turn.*(?:mismatch|does not match)/i.test(
                    detail,
                  )
                  ? followUp()
                  : Effect.fail(
                      new ProviderTurnControlError({
                        threadId: input.threadId,
                        providerTurnId: input.providerTurnId,
                        operation: "steer",
                        cause,
                      }),
                    );
              }),
            );
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "steer",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
