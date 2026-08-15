// @effect-diagnostics nodeBuiltinImport:off -- grant fingerprints must not retain reusable bearer tokens in process memory
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentCommandArgs,
  EnvironmentCommandId,
  type EnvironmentCommandKind,
  type EnvironmentCommandResult,
  type EnvironmentId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  type CloudProjectId,
  type ServerConfig,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PeerEnvironmentConnectionError,
  PeerEnvironments,
  type PeerEnvironmentGrantConsumption,
} from "./peerEnvironments.ts";
import { readCloudSyncLink, resolveCloudSyncConfig } from "./syncDaemon.ts";

export const REMOTE_ENVIRONMENT_COMMAND_TTL_MS = 60 * 60 * 1_000;

export interface EnvironmentCommandIssueInput {
  readonly companyId: string;
  readonly id: EnvironmentCommandId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly cloudProjectId: CloudProjectId | null;
  readonly kind: EnvironmentCommandKind;
  readonly args: EnvironmentCommandArgs;
  readonly ttlMs: number;
}

export class EnvironmentCommandIssueUnavailableError extends Schema.TaggedErrorClass<EnvironmentCommandIssueUnavailableError>()(
  "EnvironmentCommandIssueUnavailableError",
  {
    reason: Schema.Literals([
      "cloud-sync-unavailable",
      "cloud-sync-unlinked",
      "member-authorization-unavailable",
    ]),
    message: Schema.String,
  },
) {}

export class EnvironmentCommandIssueFailedError extends Schema.TaggedErrorClass<EnvironmentCommandIssueFailedError>()(
  "EnvironmentCommandIssueFailedError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class EnvironmentCommandIssuer extends Context.Service<
  EnvironmentCommandIssuer,
  {
    readonly issue: (
      input: EnvironmentCommandIssueInput,
    ) => Effect.Effect<
      void,
      EnvironmentCommandIssueUnavailableError | EnvironmentCommandIssueFailedError
    >;
  }
>()("@spiritdevs/pathway/cloud/remoteDispatch/EnvironmentCommandIssuer") {}

export interface RemoteDispatchInput {
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetProjectId?: ProjectId;
  readonly cloudProjectId?: CloudProjectId;
  readonly kind: EnvironmentCommandKind;
  readonly args: EnvironmentCommandArgs;
  readonly idempotencyId: EnvironmentCommandId;
  readonly connectGrantToken?: string;
}

export type RemoteDispatchResult =
  | {
      readonly delivery: "direct";
      readonly id: EnvironmentCommandId;
      readonly result: EnvironmentCommandResult;
      readonly projection: OrchestrationV2ThreadProjection | null;
    }
  | {
      readonly delivery: "deferred";
      readonly id: EnvironmentCommandId;
      readonly result: null;
      readonly projection: null;
    };

export class RemoteDispatchInvalidCommandError extends Schema.TaggedErrorClass<RemoteDispatchInvalidCommandError>()(
  "RemoteDispatchInvalidCommandError",
  {
    id: Schema.String,
    message: Schema.String,
  },
) {}

export const RemoteDispatchMissingCapability = Schema.Literals([
  "connect-grant",
  "target-project",
  "cloud-sync",
  "cloud-link",
  "member-cloud-authorization",
]);
export type RemoteDispatchMissingCapability = typeof RemoteDispatchMissingCapability.Type;

export class RemoteDispatchUnavailableError extends Schema.TaggedErrorClass<RemoteDispatchUnavailableError>()(
  "RemoteDispatchUnavailableError",
  {
    targetEnvironmentId: Schema.String,
    id: Schema.String,
    missing: Schema.Array(RemoteDispatchMissingCapability),
    directFailure: Schema.optional(Schema.String),
    deferredFailure: Schema.String,
  },
) {
  override get message(): string {
    return `Remote dispatch to '${this.targetEnvironmentId}' is unavailable; missing ${this.missing.join(", ")}.`;
  }
}

class RemoteDirectExecutionError extends Schema.TaggedErrorClass<RemoteDirectExecutionError>()(
  "RemoteDirectExecutionError",
  {
    stage: Schema.Literals(["precondition", "target-rpc"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    grantConsumption: Schema.Literals(["not-consumed", "consumed", "unknown"]),
  },
) {}

export class RemoteDispatch extends Context.Service<
  RemoteDispatch,
  {
    readonly dispatch: (
      input: RemoteDispatchInput,
    ) => Effect.Effect<
      RemoteDispatchResult,
      RemoteDispatchInvalidCommandError | RemoteDispatchUnavailableError
    >;
  }
>()("@spiritdevs/pathway/cloud/remoteDispatch") {}

function tokenFingerprint(token: string): string {
  return NodeCrypto.createHash("sha256").update(token).digest("base64url");
}

function activeRun(projection: OrchestrationV2ThreadProjection): OrchestrationV2Run | undefined {
  return projection.runs.findLast(
    (run) =>
      run.status === "preparing" ||
      run.status === "queued" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting",
  );
}

function statusResult(
  threadId: ThreadId,
  projection: OrchestrationV2ThreadProjection,
): EnvironmentCommandResult {
  const run = projection.runs.at(-1);
  const sessionStatus = (() => {
    switch (run?.status) {
      case undefined:
        return "idle" as const;
      case "preparing":
      case "queued":
      case "starting":
        return "starting" as const;
      case "running":
        return "running" as const;
      case "waiting":
        return "ready" as const;
      case "interrupted":
        return "interrupted" as const;
      case "failed":
        return "error" as const;
      case "completed":
      case "cancelled":
      case "rolled_back":
        return "stopped" as const;
    }
  })();
  return {
    kind: "statusQuery",
    threadId,
    sessionStatus,
    activeTurnId: null,
  };
}

function targetDefaultModel(projectionConfig: ServerConfig): ModelSelection | null {
  const provider = projectionConfig.providers.find(
    (candidate) =>
      candidate.enabled &&
      candidate.installed &&
      isProviderAvailable(candidate) &&
      candidate.status !== "error" &&
      candidate.status !== "disabled" &&
      candidate.auth.status !== "unauthenticated",
  );
  const model =
    provider?.models.find((candidate) => candidate.isDefault)?.slug ?? provider?.models[0]?.slug;
  return provider === undefined || model === undefined
    ? null
    : { instanceId: provider.instanceId, model };
}

const executeDirect = Effect.fn("cloud.remote_dispatch.execute_direct")(function* (
  input: RemoteDispatchInput,
  peers: PeerEnvironments["Service"],
) {
  if (input.kind === "startThread" && input.targetProjectId === undefined) {
    return yield* new RemoteDirectExecutionError({
      stage: "precondition",
      message: "A direct start-thread request needs the target environment's local project id.",
      grantConsumption: "not-consumed",
    });
  }
  if (input.connectGrantToken === undefined) {
    return yield* new RemoteDirectExecutionError({
      stage: "precondition",
      message: "No connect grant was supplied.",
      grantConsumption: "not-consumed",
    });
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* peers.connect({
        targetEnvironmentId: input.targetEnvironmentId,
        connectGrantToken: input.connectGrantToken!,
      });
      const client = handle.session.client;
      const commandId = CommandId.make(input.idempotencyId);
      switch (input.args.kind) {
        case "startThread": {
          const modelSelection =
            input.args.modelSelection ?? targetDefaultModel(yield* handle.session.initialConfig);
          if (modelSelection === null) {
            return yield* new RemoteDirectExecutionError({
              stage: "target-rpc",
              message: "The target environment has no runnable default provider model.",
              grantConsumption: "consumed",
            });
          }
          // ThreadLaunchService receipts are keyed by this command id. A durable claimant must
          // pass the environment-command id through unchanged, so an RPC reply lost after this
          // launch and the later Convex fallback converge on the same target-side receipt.
          const launched = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
            commandId,
            creationSource: "mcp",
            projectId: input.targetProjectId!,
            title: "New delegated task",
            generateTitle: true,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            workspaceStrategy: { type: "root" },
            initialMessage: {
              text: input.args.prompt,
              attachments: [],
            },
          });
          return {
            result: { kind: "startThread", threadId: launched.threadId },
            projection: launched.projection,
          } as const;
        }
        case "sendMessage": {
          const before = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: input.args.threadId,
          });
          yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId,
            threadId: input.args.threadId,
            messageId: MessageId.make(`${input.idempotencyId}:message`),
            text: input.args.message,
            attachments: [],
            dispatchMode:
              activeRun(before) === undefined
                ? { type: "start_immediately" }
                : { type: "queue_after_active" },
          });
          const projection = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: input.args.threadId,
          });
          return {
            result: { kind: "sendMessage", threadId: input.args.threadId, turnId: null },
            projection,
          } as const;
        }
        case "interrupt": {
          const projection = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: input.args.threadId,
          });
          const run = activeRun(projection);
          if (run !== undefined) {
            yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "run.interrupt",
              commandId,
              threadId: input.args.threadId,
              runId: run.id,
            });
          }
          return {
            result: { kind: "interrupt", threadId: input.args.threadId },
            projection,
          } as const;
        }
        case "statusQuery": {
          const projection = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: input.args.threadId,
          });
          return {
            result: statusResult(input.args.threadId, projection),
            projection,
          } as const;
        }
      }
    }).pipe(
      Effect.mapError((cause) => {
        if (Schema.is(PeerEnvironmentConnectionError)(cause)) return cause;
        if (Schema.is(RemoteDirectExecutionError)(cause)) return cause;
        return new RemoteDirectExecutionError({
          stage: "target-rpc",
          message: "The target environment RPC did not complete.",
          cause,
          grantConsumption: "consumed",
        });
      }),
    ),
  );
});

function peerGrantConsumption(
  error: PeerEnvironmentConnectionError | RemoteDirectExecutionError,
): PeerEnvironmentGrantConsumption {
  switch (error._tag) {
    case "PeerEnvironmentNotLinkedError":
    case "PeerEnvironmentSelfConnectError":
      return "not-consumed";
    case "PeerEnvironmentRelayRefusedError":
    case "PeerEnvironmentConnectNotAuthorizedError":
    case "PeerEnvironmentConnectionFailedError":
    case "RemoteDirectExecutionError":
      return error.grantConsumption;
  }
}

function missingForIssueError(
  error: EnvironmentCommandIssueUnavailableError | EnvironmentCommandIssueFailedError,
): RemoteDispatchMissingCapability {
  if (error._tag === "EnvironmentCommandIssueFailedError") return "cloud-sync";
  switch (error.reason) {
    case "cloud-sync-unavailable":
      return "cloud-sync";
    case "cloud-sync-unlinked":
      return "cloud-link";
    case "member-authorization-unavailable":
      return "member-cloud-authorization";
  }
}

export const make = Effect.gen(function* () {
  const peers = yield* PeerEnvironments;
  const issuer = yield* EnvironmentCommandIssuer;
  const spentGrants = yield* Ref.make<ReadonlySet<string>>(new Set());

  const dispatch = Effect.fn("cloud.remote_dispatch.dispatch")(function* (
    input: RemoteDispatchInput,
  ) {
    if (input.kind !== input.args.kind) {
      return yield* new RemoteDispatchInvalidCommandError({
        id: input.idempotencyId,
        message: "The remote command kind must match its arguments.",
      });
    }

    let directFailure: PeerEnvironmentConnectionError | RemoteDirectExecutionError | undefined;
    const fingerprint =
      input.connectGrantToken === undefined ? undefined : tokenFingerprint(input.connectGrantToken);
    const reserved =
      fingerprint === undefined
        ? false
        : yield* Ref.modify(spentGrants, (spent) =>
            spent.has(fingerprint)
              ? [false, spent]
              : ([true, new Set([...spent, fingerprint])] as const),
          );
    if (reserved) {
      const direct = yield* executeDirect(input, peers).pipe(Effect.result);
      if (direct._tag === "Success") {
        return {
          delivery: "direct",
          id: input.idempotencyId,
          result: direct.success!.result,
          projection: direct.success!.projection,
        } as const;
      }
      directFailure = direct.failure;
      if (peerGrantConsumption(direct.failure) === "not-consumed") {
        yield* Ref.update(spentGrants, (spent) => {
          const next = new Set(spent);
          next.delete(fingerprint!);
          return next;
        });
      }
    }

    const config = yield* resolveCloudSyncConfig;
    const companyId = config._tag === "Configured" ? config.settings.companyId : "";
    const deferred = yield* issuer
      .issue({
        companyId,
        id: input.idempotencyId,
        targetEnvironmentId: input.targetEnvironmentId,
        cloudProjectId: input.cloudProjectId ?? null,
        kind: input.kind,
        args: input.args,
        ttlMs: REMOTE_ENVIRONMENT_COMMAND_TTL_MS,
      })
      .pipe(Effect.result);
    if (deferred._tag === "Success") {
      return {
        delivery: "deferred",
        id: input.idempotencyId,
        result: null,
        projection: null,
      } as const;
    }

    const missing: RemoteDispatchMissingCapability[] = [];
    if (
      input.connectGrantToken === undefined ||
      (fingerprint !== undefined && !reserved) ||
      (directFailure !== undefined && peerGrantConsumption(directFailure) !== "not-consumed")
    ) {
      missing.push("connect-grant");
    }
    if (input.kind === "startThread" && input.targetProjectId === undefined) {
      missing.push("target-project");
    }
    missing.push(missingForIssueError(deferred.failure));
    return yield* new RemoteDispatchUnavailableError({
      targetEnvironmentId: input.targetEnvironmentId,
      id: input.idempotencyId,
      missing: [...new Set(missing)],
      ...(directFailure === undefined ? {} : { directFailure: directFailure.message }),
      deferredFailure: deferred.failure.message,
    });
  });

  return RemoteDispatch.of({ dispatch });
});

const environmentCommandIssuerLayer = Layer.effect(
  EnvironmentCommandIssuer,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    return EnvironmentCommandIssuer.of({
      issue: () =>
        Effect.gen(function* () {
          const config = yield* resolveCloudSyncConfig;
          if (config._tag !== "Configured") {
            return yield* new EnvironmentCommandIssueUnavailableError({
              reason: "cloud-sync-unavailable",
              message: `Cloud sync is unavailable (${config.reason}).`,
            });
          }
          if ((yield* readCloudSyncLink(secrets)) === null) {
            return yield* new EnvironmentCommandIssueUnavailableError({
              reason: "cloud-sync-unlinked",
              message: "Cloud sync has no usable environment link.",
            });
          }
          // environmentCommands.issue currently requires a member actor, while the server can
          // mint only an ENVIRONMENT service token. Refuse here instead of sending a mutation
          // Convex is guaranteed to reject or silently running the requested work locally.
          return yield* new EnvironmentCommandIssueUnavailableError({
            reason: "member-authorization-unavailable",
            message:
              "Durable remote dispatch needs member authorization that apps/server cannot currently mint.",
          });
        }),
    });
  }),
);

export const layer = Layer.effect(RemoteDispatch, make).pipe(
  Layer.provide(environmentCommandIssuerLayer),
);
