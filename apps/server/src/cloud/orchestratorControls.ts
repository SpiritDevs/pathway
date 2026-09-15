import * as Schedule from "effect/Schedule";
import { persistThreadQueueAttachment } from "./threadQueueWorker.ts";
import { ORCHESTRATOR_WORKER_REPORT_INSTRUCTIONS } from "@spiritdevs/contracts/orchestratorInspection";
import type { ChatAttachment } from "@spiritdevs/contracts";
/** Event-driven delivery of private coordinator messages and worker questions. */
import { api } from "@spiritdevs/backend/convexApi";
import {
  CommandId,
  MessageId,
  RuntimeRequestId,
  ThreadId,
  ProviderDriverKind,
  type OrchestrationV2ThreadProjection,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { ConvexClient } from "convex/browser";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { ProviderAllowanceRuntime } from "../providerUsage/AllowanceRuntime.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import type { FunctionReturnType } from "convex/server";

class WorkerControlError extends Data.TaggedError("WorkerControlError")<{
  readonly cause: unknown;
}> {}
type Inbox = FunctionReturnType<typeof api.aiOrchestratorControls.environmentInbox>;
type Assignment = Inbox[number];
export function belongsToWorker(
  projection: OrchestrationV2ThreadProjection,
  assignment: Pick<Assignment, "commandId" | "orchestratorId"> & { threadId?: string },
  companyId: string,
  root?: OrchestrationV2ThreadProjection,
) {
  if (projection.thread.id === assignment.threadId) return true;
  const origin = projection.thread.orchestratorOrigin;
  const authority = root?.thread.orchestratorOrigin;
  return (
    origin?.companyId === companyId &&
    origin.commandId === (authority?.commandId ?? assignment.commandId) &&
    origin.orchestratorId === assignment.orchestratorId
  );
}
export function workerQuestions(projection: OrchestrationV2ThreadProjection) {
  const requests = new Map(projection.runtimeRequests.map((request) => [request.id, request]));
  return projection.turnItems.flatMap((item) => {
    if (item.type !== "user_input_request") return [];
    const request = requests.get(item.requestId);
    if (
      !request ||
      request.kind !== "user_input" ||
      request.responseCapability.type === "not_resumable"
    )
      return [];
    return [
      {
        requestId: request.id,
        open: request.status === "pending",
        questions: item.questions.map((q) => ({
          id: q.id,
          question: [
            q.question,
            ...q.options.map((option) => `• ${option.label}: ${option.description}`),
            ...(q.multiSelect ? ["You may choose more than one."] : []),
            ...(q.isOther ? ["You can also give your own answer."] : []),
          ].join("\n"),
          ...(q.isSecret !== undefined ? { isSecret: q.isSecret } : {}),
        })),
      },
    ];
  });
}
/** Only successful reports suppress repeats; a failed transition remains retryable. */
export const reportWorkerQuestionChanges = Effect.fn("cloud.orchestrator.reportQuestionChanges")(
  function* (input: {
    projection: OrchestrationV2ThreadProjection;
    workId: string;
    reported: Map<string, boolean>;
    report: (
      question: ReturnType<typeof workerQuestions>[number],
    ) => Effect.Effect<unknown, WorkerControlError>;
  }) {
    for (const question of workerQuestions(input.projection)) {
      const key = JSON.stringify([input.workId, input.projection.thread.id, question.requestId]);
      if (input.reported.get(key) === question.open) continue;
      yield* input.report(question);
      input.reported.set(key, question.open);
    }
  },
);

/** Accepted rows remain durable in Convex; startup replay and scoped retries recover them. */
export const workerControlRetryWakeups = (pending: ReadonlyMap<string, Assignment>) =>
  Stream.fromEffectSchedule(
    Effect.sync(() => [...pending.values()]),
    Schedule.spaced("15 seconds"),
  ).pipe(
    Stream.filter((rows) => rows.length > 0),
    Stream.map((rows) => ({ rows, threadId: null as string | null })),
  );

const active = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.some((run) =>
    ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
  );

type AcceptedMessage = Pick<
  NonNullable<FunctionReturnType<typeof api.aiOrchestratorControls.accept>>,
  "id" | "threadId" | "mode" | "text" | "answers" | "requestId"
>;
export const workerMessageCommandId = (workId: string, id: string) =>
  CommandId.make(`orchestrator-message:${workId.length}:${workId}:${id}`);
/** Replaying an accepted cloud delivery first checks the local command receipt. */
export const executeAcceptedWorkerMessage = Effect.fn("cloud.orchestrator.deliverAccepted")(
  function* (input: {
    message: AcceptedMessage;
    assignment: Pick<Assignment, "workId" | "commandId" | "orchestratorId"> & { threadId?: string };
    root: OrchestrationV2ThreadProjection;
    companyId: string;
    threads: Pick<
      ThreadManagementService["Service"],
      "getThreadProjection" | "dispatch" | "sendToThread"
    >;
    receipts: Pick<CommandReceiptStoreV2["Service"], "getByCommandId">;
    attachments?: readonly ChatAttachment[];
    recoveryOnly?: boolean;
    admit: (target: OrchestrationV2ThreadProjection) => Effect.Effect<boolean>;
  }) {
    const { message, assignment, root, companyId, threads, receipts } = input;
    const commandId = workerMessageCommandId(assignment.workId, message.id);
    const previous = yield* receipts.getByCommandId(commandId);
    if (Option.isSome(previous)) {
      const target = yield* threads.getThreadProjection(ThreadId.make(message.threadId));
      const recovered = target.messages.find(
        (m) =>
          m.id ===
          (message.mode === "answer"
            ? `message:question-answer:${message.requestId}`
            : `${commandId}:message`),
      );
      const questionRun = target.turnItems.find(
        (item) => item.type === "user_input_request" && item.requestId === message.requestId,
      )?.runId;
      const recoveredRunId = recovered?.runId ?? questionRun;
      const recoveredMessageId =
        recovered?.id ??
        target.messages.find(
          (message) => message.runId === recoveredRunId && message.role === "user",
        )?.id;
      return {
        failed: previous.value.status === "rejected",
        ...(recoveredRunId ? { runId: recoveredRunId } : {}),
        ...(recoveredMessageId ? { messageId: recoveredMessageId } : {}),
        detail:
          previous.value.status === "accepted"
            ? "Durable local dispatch confirmed; provider completion is separate."
            : "Local dispatch was rejected.",
      };
    }
    if (input.recoveryOnly)
      return {
        failed: true,
        detail: "Delivery cancelled before dispatch because worker control is no longer enabled.",
      };
    const target = yield* threads.getThreadProjection(ThreadId.make(message.threadId));
    if (
      !belongsToWorker(target, assignment, companyId, root) ||
      target.thread.projectId !== root.thread.projectId
    )
      return {
        failed: true,
        detail: "The target is not an authorized descendant of this assignment.",
      };
    if (!(yield* input.admit(target)))
      return yield* new WorkerControlError({ cause: "Allowance currently holds this delivery." });
    if (
      message.mode === "steer" &&
      !target.runs.some((run) => run.status === "running" || run.status === "waiting")
    )
      return {
        failed: true,
        detail: "No running turn can receive steering. Send a queued follow-up instead.",
      };
    if (message.mode === "answer") {
      const request = target.runtimeRequests.find((r) => r.id === message.requestId);
      if (
        !request ||
        request.kind !== "user_input" ||
        request.status !== "pending" ||
        request.responseCapability.type === "not_resumable" ||
        workerQuestions(target).some(
          (q) => q.requestId === message.requestId && q.questions.some((field) => field.isSecret),
        )
      )
        return { failed: true, detail: "The original question is no longer answerable." };
      yield* threads.dispatch({
        type: "runtime-request.respond",
        answeredBy: "agent",
        commandId,
        threadId: target.thread.id,
        requestId: RuntimeRequestId.make(message.requestId!),
        answers: message.answers,
      });
      const updated = yield* threads.getThreadProjection(target.thread.id);
      const answer = updated.messages.find(
        (m) => m.id === `message:question-answer:${message.requestId}`,
      );
      const runId =
        answer?.runId ??
        updated.turnItems.find(
          (item) => item.type === "user_input_request" && item.requestId === message.requestId,
        )?.runId;
      const answerMessageId =
        answer?.id ?? target.messages.find((m) => m.runId === runId && m.role === "user")?.id;
      return {
        failed: false,
        ...(runId ? { runId } : {}),
        ...(answerMessageId ? { messageId: answerMessageId } : {}),
        detail: "Question response dispatched; provider processing is separate.",
      };
    }
    const sent = yield* threads.sendToThread({
      commandId,
      threadId: target.thread.id,
      projectId: target.thread.projectId,
      conversationCompanyId: target.thread.conversationCompanyId,
      messageId: MessageId.make(`${commandId}:message`),
      text: `${message.text}\n\n${ORCHESTRATOR_WORKER_REPORT_INSTRUCTIONS}`,
      attachments: input.attachments ?? [],
      mode: message.mode,
      createdBy: "agent",
      creationSource: "mcp",
    });
    return {
      failed: false,
      runId: sent.run.id,
      messageId: `${commandId}:message`,
      detail: "Durable local dispatch confirmed; provider completion is separate.",
    };
  },
);

export const runOrchestratorControls = Effect.fn("cloud.orchestrator.controls")(function* (input: {
  convexUrl: string;
  companyId: CompanyId;
  tokens: ConvexServiceTokenProvider;
}) {
  const threads = yield* ThreadManagementService;
  const receipts = yield* CommandReceiptStoreV2;
  const allowance = yield* ProviderAllowanceRuntime;
  const providers = yield* ProviderInstanceRegistry;
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new ConvexClient(input.convexUrl)),
    (c) => Effect.promise(() => c.close()),
  );
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  client.setAuth(({ forceRefreshToken }) =>
    runPromise(
      (forceRefreshToken ? input.tokens.invalidate() : Effect.void).pipe(
        Effect.andThen(input.tokens.token),
      ),
    ),
  );
  const call = <A>(fn: () => Promise<A>) =>
    Effect.tryPromise({ try: fn, catch: (cause) => new WorkerControlError({ cause }) });
  const latest = yield* Ref.make<Inbox>([]);
  const retryAssignments = new Map<string, Assignment>();
  const reportedQuestions = new Map<string, boolean>();
  const inbox = Stream.callback<Inbox, WorkerControlError>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          client.onUpdate(
            api.aiOrchestratorControls.environmentInbox,
            { companyId: input.companyId },
            (rows) => Queue.offerUnsafe(queue, rows),
            (error) =>
              Queue.failCauseUnsafe(queue, Cause.fail(new WorkerControlError({ cause: error }))),
          ),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
    { bufferSize: 1, strategy: "sliding" },
  ).pipe(
    Stream.retry(Schedule.spaced("2 seconds")),
    Stream.tap((rows) => Ref.set(latest, rows)),
    Stream.map((rows) => ({ rows, threadId: null as string | null })),
  );
  const events = threads.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "runtime-request.updated" ||
        (event.type === "turn-item.updated" && event.payload.type === "user_input_request") ||
        event.type === "run.updated" ||
        event.type === "thread.created",
    ),
    Stream.mapEffect((event) =>
      Ref.get(latest).pipe(
        Effect.map((rows) => ({ rows, threadId: event.threadId as string | null })),
      ),
    ),
  );
  const reconnects = Stream.callback<void>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          let connected = client.connectionState().isWebSocketConnected;
          return client.subscribeToConnectionState((state) => {
            if (state.isWebSocketConnected && !connected) Queue.offerUnsafe(queue, undefined);
            connected = state.isWebSocketConnected;
          });
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
    { bufferSize: 1, strategy: "sliding" },
  ).pipe(
    Stream.mapEffect(() =>
      Ref.get(latest).pipe(Effect.map((rows) => ({ rows, threadId: null as string | null }))),
    ),
  );
  yield* Stream.runForEach(
    Stream.merge(
      Stream.merge(inbox, events),
      Stream.merge(reconnects, workerControlRetryWakeups(retryAssignments)),
    ),
    ({ rows, threadId }) =>
      Effect.gen(function* () {
        // Startup/reconnect scans recover requests emitted while offline. Later events read only their thread.
        const shells = threadId === null ? (yield* threads.getShellSnapshot()).threads : [];
        const changed = threadId
          ? yield* threads.getThreadProjection(ThreadId.make(threadId))
          : null;
        const candidates = changed
          ? yield* call(() =>
              client.query(api.aiOrchestratorControls.environmentInbox, {
                companyId: input.companyId,
                threadId: changed.thread.lineage.rootThreadId,
              }),
            )
          : rows;
        const relevant = changed
          ? candidates.filter(
              (row) =>
                changed.thread.lineage.rootThreadId === row.threadId ||
                changed.thread.lineage.parentThreadId === row.threadId ||
                belongsToWorker(changed, row, input.companyId),
            )
          : rows;
        for (const assignment of relevant) {
          yield* Effect.gen(function* () {
            const root =
              changed?.thread.id === assignment.threadId
                ? changed
                : yield* threads.getThreadProjection(ThreadId.make(assignment.threadId));
            if (!belongsToWorker(root, assignment, input.companyId)) return;

            const targets = assignment.stopped
              ? []
              : threadId
                ? [threadId]
                : shells
                    .filter(
                      (shell) =>
                        shell.id === assignment.threadId ||
                        (root.thread.orchestratorOrigin &&
                          shell.orchestratorOrigin?.commandId ===
                            root.thread.orchestratorOrigin.commandId),
                    )
                    .map((shell) => shell.id);
            for (const id of targets) {
              const projection = changed ?? (yield* threads.getThreadProjection(ThreadId.make(id)));
              if (
                !belongsToWorker(projection, assignment, input.companyId, root) ||
                projection.thread.projectId !== root.thread.projectId
              )
                continue;
              yield* reportWorkerQuestionChanges({
                projection,
                workId: assignment.workId,
                reported: reportedQuestions,
                report: (question) =>
                  call(() =>
                    client.mutation(api.aiOrchestratorControls.reportQuestion, {
                      companyId: input.companyId,
                      workId: assignment.workId,
                      threadId: id,
                      ...question,
                    }),
                  ),
              });
            }
            if (!assignment.message) return;
            // Read candidate without claiming it, so queued follow-ups remain editable until an idle turn.
            const preview = yield* call(() =>
              client.query(api.aiOrchestratorControls.deliveryPreview, {
                companyId: input.companyId,
                workId: assignment.workId,
                ...assignment.message!,
              }),
            );
            if (
              !preview ||
              (preview.state === "pending" && preview.mode === "queue" && active(root))
            )
              return;
            const fence = {
              companyId: input.companyId,
              workId: assignment.workId,
              ...assignment.message,
            };
            const rootRunId =
              root.messages.find((m) => m.id === `${assignment.commandId}:message`)?.runId ??
              root.runs[0]?.id;
            const message = yield* call(() =>
              client.mutation(api.aiOrchestratorControls.accept, {
                ...fence,
                ...(rootRunId ? { rootRunId } : {}),
              }),
            );
            if (!message) return;
            const commandId = workerMessageCommandId(assignment.workId, message.id);
            const recovered = yield* receipts.getByCommandId(commandId);
            const attachments =
              Option.isNone(recovered) && !message.recoveryOnly
                ? yield* call(() =>
                    client.query(api.aiOrchestratorControls.attachmentDownloads, fence),
                  ).pipe(
                    Effect.flatMap((items) =>
                      Effect.forEach(items, (item) =>
                        persistThreadQueueAttachment(message.threadId, item),
                      ),
                    ),
                  )
                : [];
            const outcome = yield* executeAcceptedWorkerMessage({
              attachments,
              recoveryOnly: message.recoveryOnly,
              message,
              assignment,
              root,
              companyId: input.companyId,
              threads,
              receipts,
              admit: (target) =>
                Effect.gen(function* () {
                  const instance = (yield* providers.listInstances).find(
                    (p) => p.instanceId === target.thread.modelSelection.instanceId,
                  );
                  if (!instance) return false;
                  return (yield* allowance.checkThread(
                    target.thread.id,
                    instance.instanceId,
                    ProviderDriverKind.make(instance.driverKind),
                  )).canStart;
                }),
            });
            yield* call(() =>
              client.mutation(api.aiOrchestratorControls.acknowledge, { ...fence, ...outcome }),
            );
          }).pipe(
            Effect.retry({ times: 2, schedule: Schedule.spaced("2 seconds") }),
            Effect.tap(() =>
              Effect.sync(() => {
                retryAssignments.delete(assignment.workId);
              }),
            ),
            Effect.catch(() =>
              Effect.gen(function* () {
                retryAssignments.set(assignment.workId, assignment);
                yield* Effect.logDebug(
                  "Worker delivery remains unconfirmed; scheduled for recovery.",
                  {
                    workId: assignment.workId,
                  },
                );
              }),
            ),
          );
        }
      }).pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            for (const assignment of rows) retryAssignments.set(assignment.workId, assignment);
            yield* Effect.logDebug(
              "Worker control delivery remains unconfirmed; scheduled for recovery.",
            );
          }),
        ),
      ),
  );
});
