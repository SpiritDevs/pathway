/**
 * Reads a thread that lives on another environment of this environment's Pathway account.
 *
 * Pathway Cloud finds the environment that published the thread and mints a single-use connect
 * grant for the account that registered this environment. The transcript then travels over the
 * relay from that environment to this one; it never enters Pathway Cloud.
 *
 * @module cloud/remoteThreadRead
 */
import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@spiritdevs/contracts";
import { makeFunctionReference } from "convex/server";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { convexHttpClientLike } from "./convexSyncTransport.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import { PeerEnvironments } from "./peerEnvironments.ts";
import { makeCloudSyncTokenProvider, resolveCloudSyncConfig } from "./syncDaemon.ts";

const issueThreadReadRef = makeFunctionReference<
  "action",
  { threadId: string },
  { token: string; environmentId: string } | null
>("connectGrants:issueThreadRead");

export class RemoteThreadReadError extends Data.TaggedError("RemoteThreadReadError")<{
  readonly message: string;
}> {}

export interface RemoteThread {
  readonly environmentId: EnvironmentId;
  readonly projection: OrchestrationV2ThreadProjection;
  /** Threads whose messages the projection's timeline shows, such as a fork's source. */
  readonly sources: ReadonlyArray<OrchestrationV2ThreadProjection>;
}

export class RemoteThreadReader extends Context.Service<
  RemoteThreadReader,
  {
    /** `null` when no other environment the account can read publishes the thread. */
    readonly read: (
      threadId: ThreadId,
    ) => Effect.Effect<RemoteThread | null, RemoteThreadReadError>;
  }
>()("@spiritdevs/pathway/cloud/remoteThreadRead") {}

export const layer = Layer.effect(
  RemoteThreadReader,
  Effect.gen(function* () {
    const peers = yield* PeerEnvironments;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const httpClient = yield* HttpClient.HttpClient;
    const connectCloud = yield* Effect.cached(
      Effect.gen(function* () {
        const config = yield* resolveCloudSyncConfig;
        if (config._tag !== "Configured")
          return yield* new RemoteThreadReadError({
            message:
              "Connect this environment to Pathway Cloud to read threads on other environments.",
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

    const issueGrant = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const cloud = yield* connectCloud;
        const token = yield* cloud.tokens.token;
        return yield* cloud.lock.withPermits(1)(
          Effect.tryPromise(() => {
            cloud.client.setAuth(token);
            return cloud.client.action!(issueThreadReadRef, { threadId });
          }),
        );
      });

    const read = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const grant = yield* issueGrant(threadId);
        if (grant === null) return null;
        const environmentId = EnvironmentId.make(grant.environmentId);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* peers.connect({
              targetEnvironmentId: environmentId,
              connectGrantToken: grant.token,
            });
            const getProjection = (id: ThreadId) =>
              handle.session.client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
                threadId: id,
              });
            const projection = yield* getProjection(threadId);
            const sourceIds = new Set(
              projection.visibleTurnItems
                .filter(
                  (row) =>
                    row.item.type === "user_message" || row.item.type === "assistant_message",
                )
                .map((row) => row.sourceThreadId)
                .filter((id) => id !== threadId),
            );
            const sources = yield* Effect.forEach(sourceIds, getProjection, { concurrency: 4 });
            return { environmentId, projection, sources } satisfies RemoteThread;
          }),
        );
      }).pipe(
        Effect.mapError((error) =>
          error instanceof RemoteThreadReadError
            ? error
            : new RemoteThreadReadError({
                message: `Pathway could not read thread ${threadId} from its environment.`,
              }),
        ),
      );

    return RemoteThreadReader.of({ read });
  }),
);
