/** Publishes environment-local projects and their workspace bindings to Convex. */
import { api } from "@spiritdevs/backend/convexApi";
import type { EnvironmentId, Project } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";
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
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";

export const DEFAULT_CLOUD_PROJECT_RECONCILE_INTERVAL = Duration.minutes(1);

export interface CloudProjectPublisherOptions {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly convexUrl: string;
  readonly tokens: ConvexServiceTokenProvider;
  readonly client?: ConvexClientLike;
  readonly reconcileInterval?: Duration.Input;
}

class CloudProjectPublisherCallError extends Data.TaggedError("CloudProjectPublisherCallError")<{
  readonly reason: ReturnType<typeof classifyConvexFailure>;
  readonly cause: unknown;
}> {}

/** A small authenticated Convex client dedicated to project metadata publication. */
export const makeCloudProjectPublisher = Effect.fn("cloud.project_publisher.make")(function* (
  options: CloudProjectPublisherOptions,
) {
  const client = options.client ?? convexHttpClientLike(options.convexUrl);
  const lock = yield* Semaphore.make(1);

  const call = <A>(token: string, issue: (client: ConvexClientLike) => Promise<A>) =>
    lock.withPermits(1)(
      Effect.suspend(() => {
        client.setAuth(token);
        return Effect.tryPromise({
          try: () => issue(client),
          catch: (cause) =>
            new CloudProjectPublisherCallError({
              reason: classifyConvexFailure(cause),
              cause,
            }),
        });
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

  return {
    publish: (project: Project) =>
      authorized((convex) =>
        convex.mutation(api.cloudProjects.ensureEnvironmentProject, {
          companyId: options.companyId,
          environmentId: options.environmentId,
          localProjectId: project.id,
          localWorkspaceRoot: project.workspaceRoot,
          repositoryIdentity: project.repositoryIdentity ?? null,
          name: project.title,
        }),
      ).pipe(Effect.asVoid),
    release: (localProjectId: Project["id"]) =>
      authorized((convex) =>
        convex.mutation(api.cloudProjects.releaseEnvironmentProject, {
          companyId: options.companyId,
          environmentId: options.environmentId,
          localProjectId,
        }),
      ).pipe(Effect.asVoid),
  } as const;
});

/** Reconciles the startup snapshot, then follows every centralized project event. */
export const runCloudProjectPublisher = Effect.fn("cloud.project_publisher.run")(function* (
  options: CloudProjectPublisherOptions,
) {
  const projects = yield* ProjectService.ProjectService;
  const orchestration = yield* OrchestrationEngineService;
  const publisher = yield* makeCloudProjectPublisher(options);

  const reportFailure = (operation: "publish" | "release", projectId: string) =>
    Effect.catchCause((cause) =>
      Effect.logWarning("Cloud project metadata publication failed; it will be reconciled again", {
        companyId: options.companyId,
        environmentId: options.environmentId,
        projectId,
        operation,
        cause,
      }),
    );
  const publish = (project: Project) =>
    publisher.publish(project).pipe(reportFailure("publish", project.id));
  const release = (projectId: Project["id"]) =>
    publisher.release(projectId).pipe(reportFailure("release", projectId));

  const reconcile = projects.snapshot.pipe(
    Effect.flatMap((snapshot) =>
      Effect.forEach(
        snapshot.projects.filter((project) => project.deletedAt === null),
        publish,
        { concurrency: 4, discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Cloud project metadata reconciliation could not read local projects", {
        companyId: options.companyId,
        environmentId: options.environmentId,
        cause,
      }),
    ),
  );

  yield* reconcile;
  const changes = orchestration.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "project.created" ||
        event.type === "project.meta-updated" ||
        event.type === "project.deleted",
    ),
    Stream.map((event) => ({ _tag: "Project" as const, event })),
  );
  const periodic = Stream.tick(
    options.reconcileInterval ?? DEFAULT_CLOUD_PROJECT_RECONCILE_INTERVAL,
  ).pipe(Stream.map(() => ({ _tag: "Reconcile" as const })));

  yield* Stream.runForEach(Stream.merge(changes, periodic), (change) => {
    if (change._tag === "Reconcile") return reconcile;
    const event = change.event;
    if (event.type === "project.deleted") return release(event.payload.projectId);
    return projects.getById(event.payload.projectId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: publish,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Cloud project metadata publication could not read the local project", {
          companyId: options.companyId,
          environmentId: options.environmentId,
          projectId: event.payload.projectId,
          cause,
        }),
      ),
    );
  });
});

/** Keeps one publisher running for every company registered to this linked environment. */
export const cloudProjectPublisherLayer = (): Layer.Layer<
  never,
  never,
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironment
  | ProjectService.ProjectService
  | OrchestrationEngineService
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
              runCloudProjectPublisher({
                companyId,
                environmentId,
                convexUrl: config.settings.convexUrl,
                tokens,
              }),
            workerLabel: "cloud-project-publisher",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("Cloud project publisher stopped", { cause }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cloud project publisher failed to start; local projects still work", {
          cause,
        }),
      ),
    ),
  );
