/** Publishes cloud-safe Agent Thread shells to Convex for cross-client discovery. */
import { api } from "@spiritdevs/backend/convexApi";
import {
  CloudAgentThreadShell,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import {
  type ConvexClientLike,
  classifyConvexFailure,
  convexHttpClientLike,
} from "./convexSyncTransport.ts";
import {
  awaitCloudSyncLink,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
  discoverCloudSyncCompanyIds,
  makeCloudSyncTokenProvider,
  resolveCloudSyncConfig,
  superviseCloudSyncCompanies,
} from "./syncDaemon.ts";

export const DEFAULT_AGENT_THREAD_RECONCILE_INTERVAL = Duration.seconds(15);

interface CloudAgentThreadPublisherOptions {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly convexUrl: string;
  readonly tokens: ConvexServiceTokenProvider;
  readonly client?: ConvexClientLike;
  readonly reconcileInterval?: Duration.Input;
}

class CloudAgentThreadPublisherCallError extends Data.TaggedError(
  "CloudAgentThreadPublisherCallError",
)<{ readonly reason: ReturnType<typeof classifyConvexFailure>; readonly cause: unknown }> {}

export function cloudSafeThreadShell(shell: OrchestrationV2ThreadShell): CloudAgentThreadShell {
  return {
    ...shell,
    latestVisibleMessage:
      shell.latestVisibleMessage === null
        ? null
        : {
            id: shell.latestVisibleMessage.id,
            role: shell.latestVisibleMessage.role,
            updatedAt: shell.latestVisibleMessage.updatedAt,
          },
  };
}

const encodeCloudShell = Schema.encodeSync(CloudAgentThreadShell);
const encodeCloudShellIdentity = Schema.encodeSync(Schema.fromJsonString(CloudAgentThreadShell));

export function shouldPublishCloudAgentThreadEvent(event: OrchestrationV2DomainEvent): boolean {
  return (
    event.type.startsWith("thread.") ||
    event.type === "run.created" ||
    event.type === "run.updated" ||
    event.type === "runtime-request.updated" ||
    event.type === "plan.updated" ||
    (event.type === "message.updated" && !event.payload.streaming)
  );
}

const makePublisher = Effect.fn("cloud.agent_thread_publisher.make")(function* (
  options: CloudAgentThreadPublisherOptions,
) {
  const client = options.client ?? convexHttpClientLike(options.convexUrl);
  const lock = yield* Semaphore.make(1);
  const published = yield* Ref.make<ReadonlyMap<ThreadId, string>>(new Map());

  const call = <A>(token: string, issue: (client: ConvexClientLike) => Promise<A>) =>
    lock.withPermits(1)(
      Effect.tryPromise({
        try: () => {
          client.setAuth(token);
          return issue(client);
        },
        catch: (cause) =>
          new CloudAgentThreadPublisherCallError({
            reason: classifyConvexFailure(cause),
            cause,
          }),
      }),
    );
  const authorized = <A>(issue: (client: ConvexClientLike) => Promise<A>) =>
    Effect.gen(function* () {
      const token = yield* options.tokens.token;
      return yield* call(token, issue).pipe(
        Effect.catchIf(
          (error) => error.reason === "unauthorized",
          () =>
            options.tokens.invalidate(token).pipe(
              Effect.andThen(options.tokens.token),
              Effect.flatMap((refreshed) => call(refreshed, issue)),
            ),
        ),
      );
    });

  const publish = (shell: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      const encoded = encodeCloudShell(cloudSafeThreadShell(shell));
      const identity = encodeCloudShellIdentity(cloudSafeThreadShell(shell));
      if ((yield* Ref.get(published)).get(shell.id) === identity) return;
      yield* authorized((convex) =>
        convex.mutation(api.agentThreads.upsert, {
          companyId: options.companyId,
          environmentId: options.environmentId,
          threadId: shell.id,
          localProjectId: shell.projectId,
          shell: encoded,
        }),
      );
      yield* Ref.update(published, (current) => {
        const next = new Map(current);
        next.set(shell.id, identity);
        return next;
      });
    });

  const remove = (threadId: ThreadId) =>
    authorized((convex) =>
      convex.mutation(api.agentThreads.remove, {
        companyId: options.companyId,
        environmentId: options.environmentId,
        threadId,
      }),
    ).pipe(
      Effect.tap(() =>
        Ref.update(published, (current) => {
          const next = new Map(current);
          next.delete(threadId);
          return next;
        }),
      ),
      Effect.asVoid,
    );

  const reconcileIds = (threadIds: ReadonlyArray<ThreadId>) =>
    authorized((convex) =>
      convex.mutation(api.agentThreads.reconcile, {
        companyId: options.companyId,
        environmentId: options.environmentId,
        currentThreadIds: [...threadIds],
      }),
    ).pipe(Effect.asVoid);

  return { publish, remove, reconcileIds } as const;
});

export const runCloudAgentThreadPublisher = Effect.fn("cloud.agent_thread_publisher.run")(
  function* (options: CloudAgentThreadPublisherOptions) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const publisher = yield* makePublisher(options);

    const reportFailure = (operation: string, threadId?: ThreadId) =>
      Effect.catchCause((cause) =>
        Effect.logWarning("Cloud Agent Thread metadata publication failed; it will be retried", {
          companyId: options.companyId,
          environmentId: options.environmentId,
          operation,
          ...(threadId === undefined ? {} : { threadId }),
          cause,
        }),
      );

    const reconcile = Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot();
      const shells = [...snapshot.threads, ...snapshot.archivedThreads];
      // One unpublishable shell (a thread whose project binding was revoked,
      // a shell the deployed validator rejects) must not abort the cycle:
      // every other shell still publishes and stale removals below still run.
      yield* Effect.forEach(
        shells,
        (shell) => publisher.publish(shell).pipe(reportFailure("publish", shell.id)),
        {
          concurrency: 4,
          discard: true,
        },
      );
      yield* publisher.reconcileIds(shells.map((shell) => shell.id));
    }).pipe(reportFailure("reconcile"));

    const publishThread = (threadId: ThreadId) =>
      threads.getThreadShell(threadId).pipe(
        Effect.flatMap((shell) =>
          shell === null ? publisher.remove(threadId) : publisher.publish(shell),
        ),
        reportFailure("publish", threadId),
      );

    yield* reconcile;
    const events = threads.streamDomainEvents.pipe(
      Stream.filter(shouldPublishCloudAgentThreadEvent),
      Stream.map((event) => ({ _tag: "Thread" as const, threadId: event.threadId })),
    );
    const periodic = Stream.tick(
      options.reconcileInterval ?? DEFAULT_AGENT_THREAD_RECONCILE_INTERVAL,
    ).pipe(Stream.map(() => ({ _tag: "Reconcile" as const })));

    yield* Stream.runForEach(Stream.merge(events, periodic), (event) =>
      event._tag === "Reconcile" ? reconcile : publishThread(event.threadId),
    );
  },
);

/** Keeps one publisher running for every company registered to this linked environment. */
export const cloudAgentThreadPublisherLayer = (): Layer.Layer<
  never,
  never,
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironment
  | ThreadManagement.ThreadManagementService
  | HttpClient.HttpClient
> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* resolveCloudSyncConfig;
      if (config._tag !== "Configured") return;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const environmentId = yield* environment.getEnvironmentId;
      yield* forkParkedFiber(
        Effect.gen(function* () {
          const link = yield* awaitCloudSyncLink({
            secrets,
            interval: DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
            attempts: DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
          });
          if (link === null) return;
          const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets).pipe(
            Effect.orDie,
          );
          const tokens = yield* makeCloudSyncTokenProvider({
            environmentId,
            secrets,
            dpopKeys,
          });
          yield* superviseCloudSyncCompanies({
            discover: () =>
              discoverCloudSyncCompanyIds({
                convexUrl: config.settings.convexUrl,
                tokens,
              }),
            runCompany: (companyId) =>
              runCloudAgentThreadPublisher({
                companyId,
                environmentId,
                convexUrl: config.settings.convexUrl,
                tokens,
              }),
            workerLabel: "cloud-agent-thread-publisher",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("Cloud Agent Thread publisher stopped", { cause }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cloud Agent Thread publisher failed to start", { cause }),
      ),
    ),
  );
