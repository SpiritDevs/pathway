import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type RuntimeRequestId,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { openTaskQuestions } from "./SubagentProjection.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

/**
 * The request an event may open or close a question for. Adapters write the request and its
 * question item as separate events in either order, so both are reconciled the same way.
 */
function questionRequestId(event: OrchestrationV2DomainEvent): RuntimeRequestId | undefined {
  if (event.type === "runtime-request.updated") {
    return event.payload.kind === "user_input" ? event.payload.id : undefined;
  }
  if (event.type === "turn-item.updated") {
    return event.payload.type === "user_input_request" ? event.payload.requestId : undefined;
  }
  return undefined;
}

/**
 * Wakes the parent agent of an app-owned delegated task when the task asks a question it can
 * answer with task_answer. Users rarely watch child threads, so without this a blocked child
 * waits until someone notices. One wake per question; a wake still queued when the question is
 * answered or dismissed is withdrawn.
 */
export const makeHandler = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;

  return (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      const requestId = questionRequestId(event);
      if (requestId === undefined) return;
      const shell = yield* threads.getThreadShell(event.threadId);
      const parentThreadId =
        shell?.lineage.relationshipToParent === "subagent" ? shell.lineage.parentThreadId : null;
      if (parentThreadId === null) return;

      // Keyed by the question, so replays and repeated updates converge on one wake.
      const key = `${event.threadId}:${requestId}`;
      const messageId = MessageId.make(`message:delegated-task-question:${key}`);
      const child = yield* threads.getThreadProjection(event.threadId);
      const parent = yield* threads.getThreadProjection(parentThreadId);
      const question = openTaskQuestions(child).find(
        (candidate) => candidate.requestId === requestId,
      );

      if (question === undefined) {
        const queued = parent.runs.find(
          (run) => run.status === "queued" && run.userMessageId === messageId,
        );
        if (queued === undefined) return;
        yield* threads.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`server:delegated-task-question-withdraw:${key}`),
          threadId: parentThreadId,
          runId: queued.id,
        });
        return;
      }

      const task = parent.subagents.findLast(
        (candidate) =>
          candidate.origin === "app_owned" && candidate.childThreadId === child.thread.id,
      );
      if (
        task === undefined ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null ||
        parent.messages.some((message) => message.id === messageId)
      ) {
        return;
      }
      const blocking =
        child.runtimeRequests.find((request) => request.id === requestId)?.isBlocking !== false;
      const situation = blocking
        ? `Delegated task ${task.id} is blocked on a question and cannot continue until it is answered.`
        : `Delegated task ${task.id} asked a question and is still working.`;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:delegated-task-question:${key}`),
        threadId: parentThreadId,
        messageId,
        text: `${situation} Read it with task_status using taskId ${task.id}; its requestId is ${requestId}. Answer it with task_answer when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was already answered.`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.delegated-task-question.wake-failed", {
          threadId: event.threadId,
          cause,
        }),
      ),
    );
});

/**
 * Follows live events only. A restart needs no replay: startup recovery expires live questions
 * and cancels queued wakes, and a surviving async question ends its task, whose completion wake
 * already points the parent at task_status.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const handle = yield* makeHandler;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.delegated-task-question.stream-failed", { cause }),
        ),
      ),
    );
  }),
);
