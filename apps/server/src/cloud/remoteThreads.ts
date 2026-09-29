/**
 * Reads and messages threads that live on other environments reachable by this environment's
 * Pathway account.
 *
 * Pathway Cloud finds the environment that published the thread and mints a single-use connect
 * grant for the account that linked this environment. Transcripts and messages then travel over the
 * relay between the two environments; they never enter Pathway Cloud.
 *
 * @module cloud/remoteThreads
 */
import {
  AuthPeerEnvironmentScopes,
  AuthPeerReadScopes,
  type CommandId,
  EnvironmentId,
  type MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@spiritdevs/contracts";
import type { RpcSession } from "@spiritdevs/client-runtime/rpc";
import { makeFunctionReference } from "convex/server";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  sendDispatchMode,
  sendOutcome,
  type ThreadManagementDurableRunProjectionError,
  type ThreadManagementNoSteerableRunError,
  type ThreadManagementSendMode,
  type ThreadManagementSendResult,
  type ThreadManagementThreadArchivedError,
} from "../orchestration-v2/ThreadManagementService.ts";
import { convexHttpClientLike } from "./convexSyncTransport.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import { PeerEnvironments } from "./peerEnvironments.ts";
import { makeCloudSyncTokenProvider, resolveCloudSyncConfig } from "./syncDaemon.ts";

type ThreadAccess = "read" | "send";

const issueThreadAccessRef = makeFunctionReference<
  "action",
  { threadId: string; access: ThreadAccess },
  { token: string; environmentId: string } | null
>("connectGrants:issueThreadAccess");

export class RemoteThreadError extends Data.TaggedError("RemoteThreadError")<{
  readonly message: string;
}> {}

export interface RemoteThread {
  readonly environmentId: EnvironmentId;
  readonly projection: OrchestrationV2ThreadProjection;
  /** The source threads, such as a fork's origin, that `sourcesFor` asked for. */
  readonly sources: ReadonlyArray<OrchestrationV2ThreadProjection>;
}

export interface RemoteSendInput<E> {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly mode: ThreadManagementSendMode;
  /** Refuses the send after seeing the target, for example when it runs with broader access. */
  readonly authorize: (projection: OrchestrationV2ThreadProjection) => Effect.Effect<void, E>;
}

export interface RemoteSendResult {
  readonly environmentId: EnvironmentId;
  readonly run: OrchestrationV2Run;
  readonly delivery: ThreadManagementSendResult["delivery"];
}

export class RemoteThreads extends Context.Service<
  RemoteThreads,
  {
    /**
     * `null` when no other environment the account can read publishes the thread. `sourcesFor`
     * picks which source threads to fetch in the same connection.
     */
    readonly read: (
      threadId: ThreadId,
      sourcesFor: (projection: OrchestrationV2ThreadProjection) => ReadonlyArray<ThreadId>,
    ) => Effect.Effect<RemoteThread | null, RemoteThreadError>;
    /** `null` when no other environment the account can message publishes the thread. */
    readonly send: <E>(
      input: RemoteSendInput<E>,
    ) => Effect.Effect<
      RemoteSendResult | null,
      | RemoteThreadError
      | ThreadManagementThreadArchivedError
      | ThreadManagementNoSteerableRunError
      | ThreadManagementDurableRunProjectionError
      | E
    >;
  }
>()("@spiritdevs/pathway/cloud/remoteThreads") {}

export const layer = Layer.effect(
  RemoteThreads,
  Effect.gen(function* () {
    const peers = yield* PeerEnvironments;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const httpClient = yield* HttpClient.HttpClient;
    const connectCloud = yield* Effect.cached(
      Effect.gen(function* () {
        const config = yield* resolveCloudSyncConfig;
        if (config._tag !== "Configured")
          return yield* new RemoteThreadError({
            message:
              "Connect this environment to Pathway Cloud to reach threads on other environments.",
          });
        const environmentId = yield* environment.getEnvironmentId;
        const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets);
        const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets, dpopKeys }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        return {
          tokens,
          client: convexHttpClientLike(config.settings.convexUrl),
          lock: yield* Semaphore.make(1),
        };
      }),
    );

    const unreachable = (threadId: ThreadId) =>
      Effect.mapError(
        () =>
          new RemoteThreadError({
            message: `Pathway could not reach thread ${threadId} on its environment.`,
          }),
      );

    // Opens a relay session to the environment publishing `threadId`, or returns null when the
    // account cannot reach one. Read grants yield read-only sessions.
    const withThreadSession = <A, E>(
      threadId: ThreadId,
      access: ThreadAccess,
      use: (environmentId: EnvironmentId, client: RpcSession["client"]) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const cloud = yield* connectCloud.pipe(
          Effect.mapError((error) =>
            error instanceof RemoteThreadError
              ? error
              : new RemoteThreadError({
                  message: "Pathway could not authenticate this environment with Pathway Cloud.",
                }),
          ),
        );
        const token = yield* cloud.tokens.token.pipe(unreachable(threadId));
        const grant = yield* cloud.lock
          .withPermits(1)(
            Effect.tryPromise(() => {
              cloud.client.setAuth(token);
              return cloud.client.action!(issueThreadAccessRef, { threadId, access });
            }),
          )
          .pipe(unreachable(threadId));
        if (grant === null) return null;
        const environmentId = EnvironmentId.make(grant.environmentId);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* peers
              .connect({
                targetEnvironmentId: environmentId,
                connectGrantToken: grant.token,
                scopes: access === "read" ? AuthPeerReadScopes : AuthPeerEnvironmentScopes,
              })
              .pipe(unreachable(threadId));
            return yield* use(environmentId, handle.session.client);
          }),
        );
      });

    const read: RemoteThreads["Service"]["read"] = (threadId, sourcesFor) =>
      withThreadSession(threadId, "read", (environmentId, client) =>
        Effect.gen(function* () {
          const getProjection = (id: ThreadId) =>
            client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: id });
          const projection = yield* getProjection(threadId);
          const sources = yield* Effect.forEach(sourcesFor(projection), getProjection, {
            concurrency: 4,
          });
          return { environmentId, projection, sources } satisfies RemoteThread;
        }).pipe(unreachable(threadId)),
      );

    const send: RemoteThreads["Service"]["send"] = (input) =>
      withThreadSession(input.threadId, "send", (environmentId, client) =>
        Effect.gen(function* () {
          const getProjection = client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: input.threadId,
          }).pipe(unreachable(input.threadId));
          const target = yield* getProjection;
          yield* input.authorize(target);
          const dispatchMode = yield* sendDispatchMode(target, input.mode);
          yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "message.dispatch",
            commandId: input.commandId,
            threadId: input.threadId,
            messageId: input.messageId,
            text: input.text,
            attachments: [],
            dispatchMode,
            createdBy: "agent",
            creationSource: "mcp",
          }).pipe(unreachable(input.threadId));
          const { run, delivery } = yield* sendOutcome(
            yield* getProjection,
            input.messageId,
            input.mode,
          );
          return { environmentId, run, delivery } satisfies RemoteSendResult;
        }),
      );

    return RemoteThreads.of({ read, send });
  }),
);
