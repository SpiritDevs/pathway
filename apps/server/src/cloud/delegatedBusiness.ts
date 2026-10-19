/** Cloud executes a bounded business action under the worker's immutable PA origin. */
import { makeFunctionReference } from "convex/server";
import type { OrchestratorAssignmentOrigin } from "@spiritdevs/contracts/aiOrchestrator";
import { OrchestratorMcpFailure } from "@spiritdevs/contracts";
import * as Business from "@spiritdevs/contracts/delegatedBusiness";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { convexHttpClientLike } from "./convexSyncTransport.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import { makeCloudSyncTokenProvider, resolveCloudSyncConfig } from "./syncDaemon.ts";

type BusinessRequest =
  | { kind: "mail.read"; input: Business.DelegatedMailRead }
  | { kind: "mail.send"; input: Business.DelegatedMailWrite }
  | { kind: "time.read"; input: Business.DelegatedTimeRead }
  | { kind: "time.manage"; input: Business.DelegatedTimeWrite };

export function businessRequest(origin: OrchestratorAssignmentOrigin, request: BusinessRequest) {
  const { operation, ...fields } = request.input;
  const mail = request.kind.startsWith("mail.");
  const name =
    request.kind === "mail.read"
      ? {
          accounts: "listAccounts",
          messages: "listMessages",
          message: "getMessage",
          thread: "getThread",
          drafts: "listDrafts",
          sender: "getSender",
        }[request.input.operation]
      : request.kind === "mail.send"
        ? { saveDraft: "saveDraft", discardDraft: "discardDraft", send: "requestSend" }[
            request.input.operation
          ]
        : request.kind === "time.read"
          ? { list: "listMine", totals: "recentTotals" }[request.input.operation]
          : request.input.operation;
  void operation;
  return {
    name: `${mail ? "mail" : "timeTracking"}:${name}`,
    mutation: request.kind === "mail.send" || request.kind === "time.manage",
    args: { ...fields, ...(mail ? { companyId: origin.companyId } : {}), delegatedOrigin: origin },
  };
}
export class DelegatedBusiness extends Context.Service<
  DelegatedBusiness,
  {
    readonly execute: (
      origin: OrchestratorAssignmentOrigin,
      request: BusinessRequest,
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("@spiritdevs/pathway/cloud/delegatedBusiness") {}

export const layer = Layer.effect(
  DelegatedBusiness,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const config = yield* resolveCloudSyncConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const connect = yield* Effect.cached(
      Effect.gen(function* () {
        if (config._tag !== "Configured")
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Connect this environment to Pathway Cloud first.",
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
    return DelegatedBusiness.of({
      execute: (origin, request) =>
        Effect.gen(function* () {
          const backend = yield* connect;
          const token = yield* backend.tokens.token;
          const call = businessRequest(origin, request);
          return yield* backend.lock.withPermits(1)(
            Effect.tryPromise({
              try: () => {
                backend.client.setAuth(token);
                return call.mutation
                  ? backend.client.mutation(makeFunctionReference<"mutation">(call.name), call.args)
                  : backend.client.query(makeFunctionReference<"query">(call.name), call.args);
              },
              catch: (cause) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message:
                    cause instanceof Error
                      ? cause.message
                      : "The business action could not be completed.",
                }),
            }),
          );
        }).pipe(
          Effect.mapError((cause) =>
            isFailure(cause)
              ? cause
              : new OrchestratorMcpFailure({
                  code: "capability_denied",
                  message: "Pathway could not verify this PA assignment's business access.",
                }),
          ),
        ),
    });
  }),
);

const execute = Effect.fn("delegatedBusiness.execute")(function* (request: BusinessRequest) {
  const invocation = yield* McpInvocationContext;
  if (
    !invocation.orchestratorOrigin ||
    invocation.projectId ||
    !invocation.capabilities.has("orchestration")
  )
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Ask an authorized PA orchestrator to delegate this personal business action in its private conversation.",
    });
  return yield* (yield* DelegatedBusiness).execute(invocation.orchestratorOrigin, request);
});
const isFailure = Schema.is(OrchestratorMcpFailure);
const decodeMail = Schema.decodeUnknownEffect(Business.DelegatedMailReadResult);
const decodeTime = Schema.decodeUnknownEffect(Business.DelegatedTimeReadResult);
const decodeTimer = Schema.decodeUnknownEffect(Business.DelegatedTimeWriteResult);
const decodeDraftId = Schema.decodeUnknownEffect(Schema.String);
const invalidResponse = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "Pathway returned an invalid business result. Check the app before retrying a write.",
  });
export const readMail = (input: Business.DelegatedMailRead) =>
  execute({ kind: "mail.read", input }).pipe(
    Effect.flatMap(decodeMail),
    Effect.mapError((cause) => (isFailure(cause) ? cause : invalidResponse())),
  );
export const writeMail = (input: Business.DelegatedMailWrite) =>
  Effect.gen(function* () {
    const value = yield* execute({ kind: "mail.send", input });
    const draftId = input.operation === "saveDraft" ? yield* decodeDraftId(value) : input.draftId;
    return {
      draftId,
      status:
        input.operation === "saveDraft"
          ? ("draft" as const)
          : input.operation === "send"
            ? ("queued" as const)
            : ("discarded" as const),
    };
  }).pipe(Effect.mapError((cause) => (isFailure(cause) ? cause : invalidResponse())));
export const readTime = (input: Business.DelegatedTimeRead) =>
  execute({ kind: "time.read", input }).pipe(
    Effect.flatMap(decodeTime),
    Effect.mapError((cause) => (isFailure(cause) ? cause : invalidResponse())),
  );
export const writeTime = (input: Business.DelegatedTimeWrite) =>
  execute({ kind: "time.manage", input }).pipe(
    Effect.flatMap(decodeTimer),
    Effect.mapError((cause) => (isFailure(cause) ? cause : invalidResponse())),
  );
