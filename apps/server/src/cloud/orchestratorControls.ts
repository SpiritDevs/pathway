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
  assignment: Pick<Assignment, "commandId" | "orchestratorId">,
  companyId: string,
) {
  const origin = projection.thread.orchestratorOrigin;
  return (
    origin?.companyId === companyId &&
    origin.commandId === assignment.commandId &&
    origin.orchestratorId === assignment.orchestratorId
  );
}
export function workerQuestions(projection: OrchestrationV2ThreadProjection) {
  return projection.turnItems.flatMap((item) => {
    if (item.type !== "user_input_request") return [];
    const request = projection.runtimeRequests.find((r) => r.id === item.requestId);
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
        questions: item.questions.map((q) => ({ id: q.id, question: q.question })),
      },
    ];
  });
}
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
    assignment: Pick<Assignment, "workId" | "commandId" | "orchestratorId">;
    root: OrchestrationV2ThreadProjection;
    companyId: string;
    threads: Pick<
      ThreadManagementService["Service"],
      "getThreadProjection" | "dispatch" | "sendToThread"
    >;
    receipts: Pick<CommandReceiptStoreV2["Service"], "getByCommandId">;
    admit: (target: OrchestrationV2ThreadProjection) => Effect.Effect<boolean>;
  }) {
    const { message, assignment, root, companyId, threads, receipts } = input;
    const commandId = workerMessageCommandId(assignment.workId, message.id);
    const previous = yield* receipts.getByCommandId(commandId);
    if (Option.isSome(previous)) {
      const recovered = root.messages.find((m) => m.id === `${commandId}:message`);
      return {
        failed: previous.value.status === "rejected",
        ...(recovered?.runId ? { runId: recovered.runId } : {}),
        detail:
          previous.value.status === "accepted"
            ? "Durable local dispatch confirmed; provider completion is separate."
            : "Local dispatch was rejected.",
      };
    }
    const target = yield* threads.getThreadProjection(ThreadId.make(message.threadId));
    if (
      !belongsToWorker(target, assignment, companyId) ||
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
        request.responseCapability.type === "not_resumable"
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
      return {
        failed: false,
        detail: "Question response dispatched; provider processing is separate.",
      };
    }
    const sent = yield* threads.sendToThread({
      commandId,
      threadId: target.thread.id,
      projectId: target.thread.projectId,
      conversationCompanyId: target.thread.conversationCompanyId,
      messageId: MessageId.make(`${commandId}:message`),
      text: message.text,
      attachments: [],
      mode: message.mode,
      createdBy: "agent",
      creationSource: "mcp",
    });
    return {
      failed: false,
      runId: sent.run.id,
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
    Stream.merge(Stream.merge(inbox, events), reconnects),
    ({ rows, threadId }) =>
      Effect.gen(function* () {
        // Startup/reconnect scans recover requests emitted while offline. Later events read only their thread.
        const shells = threadId === null ? (yield* threads.getShellSnapshot()).threads : [];
        const changed = threadId
          ? yield* threads.getThreadProjection(ThreadId.make(threadId))
          : null;
        const relevant = changed
          ? rows.filter((row) => belongsToWorker(changed, row, input.companyId))
          : rows;
        for (const assignment of relevant) {
          if (assignment.stopped) continue;
          const root =
            changed?.thread.id === assignment.threadId
              ? changed
              : yield* threads.getThreadProjection(ThreadId.make(assignment.threadId));
          if (!belongsToWorker(root, assignment, input.companyId)) continue;

          const targets = threadId
            ? [threadId]
            : shells
                .filter((shell) => shell.orchestratorOrigin?.commandId === assignment.commandId)
                .map((shell) => shell.id);
          for (const id of targets) {
            const projection = changed ?? (yield* threads.getThreadProjection(ThreadId.make(id)));
            if (
              !belongsToWorker(projection, assignment, input.companyId) ||
              projection.thread.projectId !== root.thread.projectId
            )
              continue;
            for (const question of workerQuestions(projection))
              yield* call(() =>
                client.mutation(api.aiOrchestratorControls.reportQuestion, {
                  companyId: input.companyId,
                  workId: assignment.workId,
                  threadId: id,
                  ...question,
                }),
              );
          }
          if (!assignment.message) continue;
          const selection = root.thread.modelSelection;
          const provider = (yield* providers.listInstances).find(
            (p) => p.instanceId === selection.instanceId,
          );
          if (!provider) continue;
          if (
            !(yield* allowance.checkThread(
              root.thread.id,
              selection.instanceId,
              ProviderDriverKind.make(provider.driverKind),
            )).canStart
          )
            continue;
          // Read candidate without claiming it, so queued follow-ups remain editable until an idle turn.
          const preview = yield* call(() =>
            client.query(api.aiOrchestratorControls.deliveryPreview, {
              companyId: input.companyId,
              workId: assignment.workId,
              ...assignment.message!,
            }),
          );
          if (!preview || (preview.state === "pending" && preview.mode === "queue" && active(root)))
            continue;
          const fence = {
            companyId: input.companyId,
            workId: assignment.workId,
            ...assignment.message,
          };
          const message = yield* call(() =>
            client.mutation(api.aiOrchestratorControls.accept, fence),
          );
          if (!message) continue;
          const outcome = yield* executeAcceptedWorkerMessage({
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
        }
      }).pipe(
        Effect.catch(() =>
          Effect.logDebug(
            "Worker control delivery remains unconfirmed; retained for event-driven recovery.",
          ),
        ),
      ),
  );
});
