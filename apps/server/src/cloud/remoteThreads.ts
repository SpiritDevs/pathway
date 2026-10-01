/**
 * Reads, messages, and starts threads on other environments reachable by this environment's
 * Pathway account.
 *
 * Pathway Cloud finds the environment that published the thread and mints a single-use connect
 * grant for the account that linked this environment. Transcripts and messages then travel over the
 * relay between the two environments; they never enter Pathway Cloud.
 *
 * @module cloud/remoteThreads
 */
import {
  AuthPeerReadScopes,
  AuthPeerSendScopes,
  AuthPeerThreadAccessUnsupportedCode,
  type CommandId,
  EnvironmentId,
  type MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
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
import { convexErrorCode } from "./convexServiceToken.ts";
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
const launchTargetsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  RemoteLaunchTarget[]
>("connectGrants:launchTargets");
const issueProjectLaunchRef = makeFunctionReference<
  "action",
  { environmentId: string; localProjectId: string },
  { token: string } | null
>("connectGrants:issueProjectLaunch");

/** Another environment, with the projects this environment's account may start threads in. */
export interface RemoteLaunchTarget {
  readonly environmentId: string;
  readonly label: string;
  readonly lastSeenAt: number | null;
  /** The environment runs a Pathway too old to accept a remote launch. */
  readonly updateRequired: boolean;
  readonly projects: ReadonlyArray<{
    readonly localProjectId: string;
    readonly name: string;
    readonly workspaceRoot: string;
  }>;
}

/** Why Pathway Cloud refused a thread grant, in words an agent can act on. */
export function grantFailureMessage(threadId: ThreadId, cause: unknown): string {
  return convexErrorCode(cause) === AuthPeerThreadAccessUnsupportedCode
    ? `Thread ${threadId} is on an environment running an older Pathway that cannot limit remote thread access. Update Pathway there to reach it remotely.`
    : `Pathway could not reach thread ${threadId} on its environment.`;
}

/**
 * What a remote send does with the target it found. A deleted thread is missing. A message already
 * on the thread means an earlier attempt landed but its reply was lost, so the retry reports that
 * outcome instead of re-checking whether a fresh send would still be allowed.
 */
export type RemoteSendPlan =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "AlreadySent" }
  | {
      readonly _tag: "Dispatch";
      readonly dispatchMode: Effect.Success<ReturnType<typeof sendDispatchMode>>;
    };

export function planRemoteSend(
  target: OrchestrationV2ThreadProjection,
  messageId: MessageId,
  mode: ThreadManagementSendMode,
): Effect.Effect<
  RemoteSendPlan,
  ThreadManagementThreadArchivedError | ThreadManagementNoSteerableRunError
> {
  if (target.thread.deletedAt !== null) return Effect.succeed({ _tag: "Missing" } as const);
  if (target.messages.some((message) => message.id === messageId))
    return Effect.succeed({ _tag: "AlreadySent" } as const);
  return sendDispatchMode(target, mode).pipe(
    Effect.map((dispatchMode) => ({ _tag: "Dispatch", dispatchMode }) as const),
  );
}

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

/**
 * Sends one message through an open session to the environment holding the thread. `null` means
 * the thread is deleted there.
 */
export const sendOnTarget = <E>(
  client: Pick<
    RpcSession["client"],
    | typeof ORCHESTRATION_V2_WS_METHODS.getThreadProjection
    | typeof ORCHESTRATION_V2_WS_METHODS.dispatchCommand
  >,
  environmentId: EnvironmentId,
  input: RemoteSendInput<E>,
) =>
  Effect.gen(function* () {
    const getProjection = client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
      threadId: input.threadId,
    }).pipe(unreachable(input.threadId));
    const target = yield* getProjection;
    const plan = yield* planRemoteSend(target, input.messageId, input.mode);
    if (plan._tag === "Missing") return null;
    // An already-landed message was authorized when it was sent; re-checking the target's
    // current modes could turn a successful retry into a failure.
    if (plan._tag === "Dispatch") {
      yield* input.authorize(target);
      yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "message.dispatch",
        commandId: input.commandId,
        threadId: input.threadId,
        messageId: input.messageId,
        text: input.text,
        attachments: [],
        dispatchMode: plan.dispatchMode,
        createdBy: "agent",
        creationSource: "mcp",
      }).pipe(unreachable(input.threadId));
    }
    const { run, delivery } = yield* sendOutcome(yield* getProjection, input.messageId, input.mode);
    return { environmentId, run, delivery } satisfies RemoteSendResult;
  });

const unreachable = (threadId: ThreadId) =>
  Effect.mapError(
    () =>
      new RemoteThreadError({
        message: `Pathway could not reach thread ${threadId} on its environment.`,
      }),
  );

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
    readonly launchTargets: Effect.Effect<ReadonlyArray<RemoteLaunchTarget>, RemoteThreadError>;
    /**
     * A single-use connect grant for starting one thread in `projectId` on `environmentId`.
     * `null` when the account may not start threads there.
     */
    readonly launchGrant: (
      environmentId: EnvironmentId,
      projectId: ProjectId,
    ) => Effect.Effect<string | null, RemoteThreadError>;
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

    const callCloud = <A>(
      call: (client: Effect.Success<typeof connectCloud>["client"]) => Promise<A>,
      failure: (cause: unknown) => string,
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
        const token = yield* cloud.tokens.token.pipe(
          Effect.mapError((cause) => new RemoteThreadError({ message: failure(cause) })),
        );
        return yield* cloud.lock.withPermits(1)(
          Effect.tryPromise({
            try: () => {
              cloud.client.setAuth(token);
              return call(cloud.client);
            },
            catch: (cause) => new RemoteThreadError({ message: failure(cause) }),
          }),
        );
      });

    // Opens a relay session to the environment publishing `threadId`, or returns null when the
    // account cannot reach one. Read grants yield read-only sessions.
    const withThreadSession = Effect.fn("RemoteThreads.withThreadSession")(function* <A, E>(
      threadId: ThreadId,
      access: ThreadAccess,
      use: (environmentId: EnvironmentId, client: RpcSession["client"]) => Effect.Effect<A, E>,
    ) {
      const grant = yield* callCloud(
        (client) => client.action!(issueThreadAccessRef, { threadId, access }),
        (cause) => grantFailureMessage(threadId, cause),
      );
      if (grant === null) return null;
      const environmentId = EnvironmentId.make(grant.environmentId);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* peers
            .connect({
              targetEnvironmentId: environmentId,
              connectGrantToken: grant.token,
              scopes: access === "read" ? AuthPeerReadScopes : AuthPeerSendScopes,
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
        sendOnTarget(client, environmentId, input),
      );

    const launchTargets = callCloud(
      (client) => client.query(launchTargetsRef, {}),
      () => "Pathway could not list the environments this account can start threads on.",
    );

    const launchGrant: RemoteThreads["Service"]["launchGrant"] = (environmentId, projectId) =>
      callCloud(
        (client) =>
          client.action!(issueProjectLaunchRef, { environmentId, localProjectId: projectId }),
        (cause) =>
          convexErrorCode(cause) === AuthPeerThreadAccessUnsupportedCode
            ? `Environment ${environmentId} runs an older Pathway that cannot accept remote launches. Update Pathway there first.`
            : `Pathway could not authorize starting a thread on environment ${environmentId}.`,
      ).pipe(Effect.map((grant) => grant?.token ?? null));

    return RemoteThreads.of({ read, launchTargets, launchGrant, send });
  }),
);
