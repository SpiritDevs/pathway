// @effect-diagnostics anyUnknownInErrorContext:off -- the Convex transport boundary preserves external failures for the durable blocked status
// @effect-diagnostics unknownInEffectCatch:off
/** Accepts cloud-saved user messages into the environment's durable orchestration log. */
import { api } from "@spiritdevs/backend/convexApi";
import {
  CommandId,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2Command,
  MessageId,
  ProjectId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { ThreadQueueAcceptance, ThreadQueueHead } from "@spiritdevs/contracts/threadQueue";
import { ConvexClient } from "convex/browser";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import { convexErrorCode, type ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import {
  awaitCloudSyncLink,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
  discoverCloudSyncCompanyIds,
  makeCloudSyncTokenProvider,
  resolveCloudSyncConfig,
  superviseCloudSyncCompanies,
} from "./syncDaemon.ts";

const decodeLaunchInput = Schema.decodeUnknownEffect(OrchestrationV2ThreadLaunchInput);
const decodeQueueCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);

export interface ThreadQueueBackend {
  readonly heads: Stream.Stream<readonly ThreadQueueHead[], unknown>;
  readonly prepare: (head: ThreadQueueHead) => Effect.Effect<ThreadQueueAcceptance | null, unknown>;
  readonly accept: (head: ThreadQueueHead) => Effect.Effect<ThreadQueueAcceptance | null, unknown>;
  readonly acknowledge: (head: ThreadQueueHead) => Effect.Effect<void, unknown>;
  readonly reportBlocked: (
    head: ThreadQueueHead,
    error: string,
    phase: "preflight" | "delivery",
    rejection?: "command" | "initial-message",
  ) => Effect.Effect<void, unknown>;
}

/** Preparation may download files and validate prerequisites; only the returned effect writes orchestration. */
export interface ThreadQueueExecutor {
  readonly wakeups?: Stream.Stream<string, unknown>;
  readonly rejectionProof?: (
    accepted: ThreadQueueAcceptance,
  ) => Effect.Effect<"command" | "initial-message" | undefined, unknown>;
  readonly prepare: (
    accepted: ThreadQueueAcceptance,
  ) => Effect.Effect<Effect.Effect<void, unknown> | null, unknown>;
}

export function threadQueueDeliveryCommandId(head: ThreadQueueHead) {
  return CommandId.make(
    (head.deliveryAttempt ?? 0) === 0
      ? head.commandId
      : `${head.commandId}:queue-retry:${head.deliveryAttempt}`,
  );
}

export function threadQueueDispatchMode(
  mode: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"],
) {
  return mode.type === "steer_active" || mode.type === "restart_active"
    ? mode
    : { type: "queue_after_active" as const };
}

export const deliverThreadQueueHead = Effect.fn("cloud.thread_queue.deliver")(function* (
  backend: ThreadQueueBackend,
  executor: ThreadQueueExecutor,
  head: ThreadQueueHead,
) {
  yield* Effect.annotateCurrentSpan({
    threadId: head.threadId,
    commandId: head.commandId,
    revision: head.revision,
  });
  const candidate = yield* backend.prepare(head).pipe(
    Effect.catchIf(
      (error) =>
        ["attachment-unavailable", "permission-denied", "binding-unavailable"].includes(
          convexErrorCode(error) ?? "",
        ),
      (error) =>
        backend
          .reportBlocked(
            head,
            error instanceof Error ? error.message : String(error),
            head.state === "accepted" ? "delivery" : "preflight",
          )
          .pipe(Effect.as(null)),
    ),
  );
  if (candidate === null) return;
  const prepared = yield* Effect.exit(executor.prepare(candidate));
  if (Exit.isFailure(prepared)) {
    yield* backend.reportBlocked(
      candidate,
      Cause.pretty(prepared.cause).slice(0, 2_000),
      candidate.state === "accepted" ? "delivery" : "preflight",
      candidate.state === "accepted" && executor.rejectionProof
        ? yield* executor.rejectionProof(candidate).pipe(Effect.orElseSucceed(() => undefined))
        : undefined,
    );
    return;
  }
  if (prepared.value === null) return;
  // Reassignment/edit/cancel can win while attachments download. Accept validates the same
  // revision atomically; only the winner may invoke the prepared local write.
  const accepted = yield* backend.accept(head).pipe(
    Effect.catchIf(
      (error) =>
        ["attachment-unavailable", "permission-denied", "binding-unavailable"].includes(
          convexErrorCode(error) ?? "",
        ),
      (error) =>
        backend
          .reportBlocked(
            head,
            error instanceof Error ? error.message : String(error),
            candidate.state === "accepted" ? "delivery" : "preflight",
          )
          .pipe(Effect.as(null)),
    ),
  );
  if (accepted === null) return;
  const persisted = yield* Effect.exit(prepared.value);
  if (Exit.isFailure(persisted)) {
    // A dispatch error can arrive after a durable write. Never let another environment take it.
    yield* backend.reportBlocked(
      accepted,
      Cause.pretty(persisted.cause).slice(0, 2_000),
      "delivery",
      executor.rejectionProof
        ? yield* executor.rejectionProof(accepted).pipe(Effect.orElseSucceed(() => undefined))
        : undefined,
    );
    return;
  }
  // Cloud content remains retained until this acknowledgement succeeds. Replayed commands use
  // the same durable local receipt, including after a process crash or lost cloud response.
  yield* backend.acknowledge(accepted);
});

export const runThreadQueueWorker = Effect.fn("cloud.thread_queue.run")(function* (
  backend: ThreadQueueBackend,
  executor: ThreadQueueExecutor,
) {
  const latest = yield* Ref.make<readonly ThreadQueueHead[]>([]);
  const cloudHeads = backend.heads.pipe(Stream.tap((heads) => Ref.set(latest, heads)));
  const readyHeads = executor.wakeups
    ? Stream.merge(
        cloudHeads,
        executor.wakeups.pipe(
          Stream.mapEffect((threadId) =>
            Ref.get(latest).pipe(
              Effect.map((heads) => heads.filter((head) => head.threadId === threadId)),
            ),
          ),
        ),
      )
    : cloudHeads;
  yield* Stream.runForEach(readyHeads, (heads) =>
    Effect.forEach(
      heads,
      (head) =>
        deliverThreadQueueHead(backend, executor, head).pipe(
          // Only transport failures retry automatically. Explicit prerequisite/execution failures
          // are stored as blocked by deliverThreadQueueHead and wait for the user's retry.
          Effect.retry({ schedule: Schedule.spaced("2 seconds") }),
        ),
      { concurrency: 4, discard: true },
    ),
  );
});

export const makeThreadQueueBackend = Effect.fn("cloud.thread_queue.backend")(function* (input: {
  readonly convexUrl: string;
  readonly companyId: CompanyId;
  readonly tokens: ConvexServiceTokenProvider;
}) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new ConvexClient(input.convexUrl)),
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
  const call = <A>(issue: () => Promise<A>) =>
    Effect.tryPromise({ try: issue, catch: (error) => error });
  const args = (head: ThreadQueueHead) => ({
    companyId: input.companyId,
    threadId: head.threadId,
    commandId: head.commandId,
    revision: head.revision,
  });
  return {
    heads: Stream.callback<readonly ThreadQueueHead[], unknown>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            client.onUpdate(
              api.threadQueue.environmentHead,
              { companyId: input.companyId },
              (heads) => Queue.offerUnsafe(queue, heads),
              (error) => Queue.failCauseUnsafe(queue, Cause.fail(error)),
            ),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        ).pipe(Effect.asVoid),
      { bufferSize: 1, strategy: "sliding" },
    ),
    prepare: (head) => call(() => client.query(api.threadQueue.prepare, args(head))),
    accept: (head) => call(() => client.mutation(api.threadQueue.accept, args(head))),
    acknowledge: (head) =>
      call(() => client.mutation(api.threadQueue.acknowledge, args(head))).pipe(Effect.asVoid),
    reportBlocked: (head, error, phase, rejection) =>
      call(() =>
        client.mutation(api.threadQueue.reportBlocked, {
          ...args(head),
          error,
          phase,
          ...(rejection === undefined ? {} : { rejection }),
        }),
      ).pipe(Effect.asVoid),
  } satisfies ThreadQueueBackend;
});

export const persistThreadQueueAttachment = Effect.fn("cloud.thread_queue.attachment")(function* (
  threadId: string,
  item: ThreadQueueAcceptance["attachments"][number],
) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const client = yield* HttpClient.HttpClient;
  const id = createDeterministicAttachmentId(threadId, item.attachment.id);
  if (id === null)
    return yield* Effect.fail("The queued attachment has an invalid thread identity.");
  const attachment: ChatAttachment = { ...item.attachment, id };
  const finalPath = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
  if (finalPath === null)
    return yield* Effect.fail(
      `Attachment ${attachment.name} is not supported by this environment.`,
    );
  const existing = yield* fs.stat(finalPath).pipe(Effect.option);
  if (Option.isSome(existing) && existing.value.size === BigInt(attachment.sizeBytes))
    return attachment;
  const partPath = `${finalPath}.${yield* randomUuidV4}.part`;
  yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
  const response = yield* client.get(item.url);
  if (response.status < 200 || response.status >= 300)
    return yield* Effect.fail(`Could not download ${attachment.name} (${response.status}).`);
  let receivedBytes = 0;
  yield* Effect.gen(function* () {
    yield* Stream.run(
      response.stream.pipe(
        Stream.mapEffect((chunk) => {
          receivedBytes += chunk.byteLength;
          return receivedBytes > attachment.sizeBytes
            ? Effect.fail(`Attachment ${attachment.name} exceeds its saved size.`)
            : Effect.succeed(chunk);
        }),
      ),
      fs.sink(partPath),
    );
    if (receivedBytes !== attachment.sizeBytes)
      return yield* Effect.fail(
        `Attachment ${attachment.name} was incomplete. Retry to download it again.`,
      );
    yield* fs.rename(partPath, finalPath);
  }).pipe(Effect.onError(() => fs.remove(partPath, { force: true }).pipe(Effect.ignore)));
  return attachment;
});

export const makeLocalThreadQueueExecutor = Effect.fn("cloud.thread_queue.executor")(function* (
  companyId: CompanyId,
) {
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const services = yield* Effect.context<
    FileSystem.FileSystem | ServerConfig.ServerConfig | HttpClient.HttpClient
  >();
  const validateModel = Effect.fn("cloud.thread_queue.validate_model")(function* (
    selection: ModelSelection,
  ) {
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    if (
      provider === undefined ||
      !provider.enabled ||
      !provider.installed ||
      provider.availability === "unavailable"
    )
      return yield* Effect.fail(
        `Provider ${selection.instanceId} is unavailable on this environment. Install or enable it, then retry.`,
      );
    if (provider.auth.status === "unauthenticated")
      return yield* Effect.fail(
        `Sign in to ${provider.displayName ?? selection.instanceId} on this environment, then retry.`,
      );
  });
  return {
    wakeups: threads.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "run.updated" &&
          ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
            event.payload.status,
          ),
      ),
      Stream.map((event) => event.threadId),
    ),
    rejectionProof: Effect.fn("cloud.thread_queue.rejection_proof")(function* (accepted) {
      const commandId = threadQueueDeliveryCommandId(accepted);
      const receipt = yield* receipts.getByCommandId(commandId);
      if (Option.isSome(receipt) && receipt.value.status === "rejected") return "command" as const;
      if (accepted.submission.kind === "launch" && Option.isSome(receipt)) {
        const initial = yield* receipts.getByCommandId(
          CommandId.make(`${commandId}:initial-message`),
        );
        if (Option.isSome(initial) && initial.value.status === "rejected")
          return "initial-message" as const;
      }
      return undefined;
    }),
    prepare: Effect.fn("cloud.thread_queue.prepare")(function* (accepted) {
      let submission = accepted.submission;
      if (submission.kind === "launch") {
        submission = {
          ...submission,
          input: yield* decodeLaunchInput(submission.input),
        };
      } else {
        const input = yield* decodeQueueCommand(submission.input);
        if (input.type !== "message.dispatch")
          return yield* Effect.fail("Only user messages can be delivered from the thread queue.");
        submission = { ...submission, input };
      }
      const receiptId = threadQueueDeliveryCommandId(accepted);
      const receipt = yield* receipts.getByCommandId(receiptId);
      if (Option.isSome(receipt) && receipt.value.status === "rejected")
        return yield* Effect.fail(receipt.value.error ?? "The environment rejected this message.");
      if (submission.kind === "message" && Option.isSome(receipt)) return Effect.void;
      if (submission.kind === "message" && Option.isNone(receipt)) {
        const projection = yield* threads.getThreadProjection(ThreadId.make(accepted.threadId));
        const mode = submission.input.dispatchMode;
        if (
          mode.type !== "steer_active" &&
          mode.type !== "restart_active" &&
          projection.runs.some((run) =>
            ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
          )
        )
          return null;
      }
      // A launch receipt alone does not prove the initial message or preparation workflow was
      // persisted. Replay ThreadLaunchService to complete any interrupted acceptance.
      const attachments = yield* Effect.gen(function* () {
        if (Option.isNone(receipt)) {
          if (
            accepted.localProjectId !== null &&
            Option.isNone(yield* projects.getById(ProjectId.make(accepted.localProjectId)))
          )
            return yield* Effect.fail(
              "The selected project is missing on this environment. Restore it or move this thread to another environment.",
            );
          const selection =
            submission.input.modelSelection ??
            (yield* threads.getThreadProjection(ThreadId.make(accepted.threadId))).thread
              .modelSelection;
          yield* validateModel(selection);
          if (submission.kind === "message") {
            const mode = submission.input.dispatchMode;
            if (mode.type === "steer_active" || mode.type === "restart_active") {
              const projection = yield* threads.getThreadProjection(
                ThreadId.make(accepted.threadId),
              );
              if (
                !projection.runs.some(
                  (run) =>
                    run.id === mode.targetRunId &&
                    ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
                )
              )
                return yield* Effect.fail(
                  "The turn this message targeted has ended. Cancel this queued message and send it as a new turn.",
                );
            }
          }
        }
        return yield* Effect.forEach(
          accepted.attachments,
          (attachment) =>
            persistThreadQueueAttachment(accepted.threadId, attachment).pipe(
              Effect.provideContext(services),
            ),
          { concurrency: 4 },
        );
      });
      if (submission.kind === "launch") {
        const { initialMessage, ...launchInput } = submission.input;
        return launcher
          .launch({
            ...launchInput,
            reuseExistingThread: submission.input.reuseExistingThread ?? false,
            generateTitle: submission.input.generateTitle ?? false,
            locations: submission.input.locations ?? [],
            commandId: receiptId,
            threadId: ThreadId.make(accepted.threadId),
            projectId:
              accepted.localProjectId === null ? null : ProjectId.make(accepted.localProjectId),
            ...(accepted.localProjectId === null ? { conversationCompanyId: companyId } : {}),
            ...(initialMessage === undefined
              ? {}
              : {
                  initialMessage: {
                    ...initialMessage,
                    messageId: initialMessage.messageId ?? MessageId.make(`${receiptId}:message`),
                    attachments,
                  },
                }),
            createdBy: "user",
            creationSource: submission.input.creationSource ?? "web",
          })
          .pipe(Effect.asVoid);
      }
      return Effect.gen(function* () {
        if (submission.runtimeMode !== undefined)
          yield* threads.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(`${receiptId}:runtime-mode`),
            threadId: ThreadId.make(accepted.threadId),
            runtimeMode: submission.runtimeMode,
          });
        if (submission.interactionMode !== undefined)
          yield* threads.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make(`${receiptId}:interaction-mode`),
            threadId: ThreadId.make(accepted.threadId),
            interactionMode: submission.interactionMode,
          });
        yield* threads.dispatch({
          ...submission.input,
          commandId: receiptId,
          threadId: ThreadId.make(accepted.threadId),
          attachments,
          dispatchMode: threadQueueDispatchMode(submission.input.dispatchMode),
          createdBy: "user",
        });
      });
    }),
  } satisfies ThreadQueueExecutor;
});

export const threadQueueWorkerLayer = () =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      if ((yield* Config.string("VITEST").pipe(Config.withDefault(""))).length > 0) return;
      const config = yield* resolveCloudSyncConfig;
      if (config._tag !== "Configured") return;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
      yield* forkParkedFiber(
        Effect.gen(function* () {
          if (
            (yield* awaitCloudSyncLink({
              secrets,
              interval: DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
              attempts: DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
            })) === null
          )
            return;
          const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets);
          const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets, dpopKeys });
          yield* superviseCloudSyncCompanies({
            discover: () =>
              discoverCloudSyncCompanyIds({ convexUrl: config.settings.convexUrl, tokens }),
            runCompany: (companyId) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const backend = yield* makeThreadQueueBackend({
                    convexUrl: config.settings.convexUrl,
                    companyId,
                    tokens,
                  });
                  const executor = yield* makeLocalThreadQueueExecutor(companyId);
                  yield* runThreadQueueWorker(backend, executor);
                }),
              ),
            workerLabel: "thread-queue",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("Cloud thread queue worker stopped", { cause }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cloud thread queue worker could not start", { cause }),
      ),
    ),
  ).pipe(Layer.provide(Receipts.layer));
