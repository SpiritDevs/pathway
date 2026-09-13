import * as NodeOS from "node:os";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { agentTimeSummaryPrompt, parseAgentTimeSummary } from "./agentTimeSummary.ts";
/** Sends durable agent work intervals while clients are closed or disconnected. */
import { makeFunctionReference } from "convex/server";
import type { EnvironmentId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import { agentTimeSessionPayload } from "./agentTimeTracking.ts";
import { makeAgentTimeTrackingStore } from "./agentTimeTrackingStore.ts";
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

const syncAgentSession = makeFunctionReference<
  "mutation",
  { companyId: string; session: ReturnType<typeof agentTimeSessionPayload> },
  { outcome: "published" | "unchanged" | "unbound" }
>("timeTracking:syncAgentSession");

class TimeTrackingPublishError extends Data.TaggedError("TimeTrackingPublishError")<{
  readonly cause: unknown;
  readonly reason: ReturnType<typeof classifyConvexFailure>;
}> {}

interface TimeTrackingPublisherOptions {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly convexUrl: string;
  readonly tokens: ConvexServiceTokenProvider;
  readonly client?: ConvexClientLike;
}

export const runCloudTimeTrackingPublisher = Effect.fn("cloud.time_tracking_publisher.run")(
  function* (options: TimeTrackingPublisherOptions) {
    const store = yield* makeAgentTimeTrackingStore(options.companyId);
    const threads = yield* ThreadManagement.ThreadManagementService;
    const generation = yield* TextGeneration;
    const settingsService = yield* ServerSettingsService;
    const summarize = Effect.fn("cloud.time_tracking.summarize")(function* () {
      const session = yield* store.nextSummary();
      if (session === null) return;
      const context = yield* store.summaryContext(session);
      const settings = yield* settingsService.getSettings;
      if (context.length === 0) {
        yield* store.deferSummary(session);
        return;
      }
      yield* generation
        .investigate({
          cwd: NodeOS.tmpdir(),
          contentOnly: true,
          prompt: agentTimeSummaryPrompt(context),
          modelSelection: settings.timeTrackerModelSelection,
        })
        .pipe(
          Effect.timeout(Duration.seconds(45)),
          Effect.flatMap((result) => Effect.try(() => parseAgentTimeSummary(result.text))),
          Effect.flatMap((summary) => store.saveSummary(session, summary)),
          Effect.catch((error) =>
            Effect.logWarning("Time entry summary failed; retrying in five minutes", {
              runId: session.id,
              error,
            }).pipe(Effect.andThen(store.deferSummary(session))),
          ),
        );
    });
    yield* Effect.forkChild(
      Stream.runForEach(Stream.tick(Duration.seconds(2)), () =>
        summarize().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Time entry summary will retry", { cause }),
          ),
        ),
      ),
    );
    const client = options.client ?? convexHttpClientLike(options.convexUrl);
    const publish = Effect.fn("cloud.time_tracking_publisher.publish")(function* () {
      // Drain persisted lifecycle changes before advancing any live clock to the heartbeat time.
      while (yield* store.capture()) {
        /* bounded pages of lifecycle events */
      }
      const now = yield* Clock.currentTimeMillis;
      const pending = yield* store.pending(now);
      for (const session of pending) {
        const call = (token: string) =>
          Effect.tryPromise({
            try: () => {
              client.setAuth(token);
              return client.mutation(syncAgentSession, {
                companyId: options.companyId,
                session: agentTimeSessionPayload(session),
              });
            },
            catch: (cause) =>
              new TimeTrackingPublishError({ cause, reason: classifyConvexFailure(cause) }),
          });
        yield* Effect.gen(function* () {
          const token = yield* options.tokens.token;
          const result = yield* call(token).pipe(
            Effect.catchIf(
              (error) => error.reason === "unauthorized",
              () =>
                options.tokens
                  .invalidate(token)
                  .pipe(Effect.andThen(options.tokens.token), Effect.flatMap(call)),
            ),
          );
          if (result.outcome === "unbound") yield* store.deferUnbound(session, now);
          else yield* store.acknowledge(session);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Agent time publication failed; durable session will retry", {
              companyId: options.companyId,
              runId: session.id,
              cause,
            }),
          ),
        );
      }
    });
    const reconcile = publish().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Agent time capture will retry", { cause })),
    );
    yield* reconcile;
    const changes = threads.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "run.created" ||
          event.type === "run.updated" ||
          event.type === "runtime-request.updated" ||
          event.type === "thread.deleted",
      ),
    );
    yield* Stream.runForEach(
      Stream.merge(changes.pipe(Stream.map(() => undefined)), Stream.tick(Duration.seconds(15))),
      () => reconcile,
    );
  },
);

/** Keeps one publisher running for every company registered to this linked environment. */
export const cloudTimeTrackingPublisherLayer = (): Layer.Layer<
  never,
  never,
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironment
  | ThreadManagement.ThreadManagementService
  | HttpClient.HttpClient
  | SqlClient.SqlClient
  | TextGeneration
  | ServerSettingsService
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
              runCloudTimeTrackingPublisher({
                companyId,
                environmentId,
                convexUrl: config.settings.convexUrl,
                tokens,
              }),
            workerLabel: "cloud-time-tracking-publisher",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("Cloud time tracking publisher stopped", { cause }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cloud time tracking publisher failed to start", { cause }),
      ),
    ),
  );
