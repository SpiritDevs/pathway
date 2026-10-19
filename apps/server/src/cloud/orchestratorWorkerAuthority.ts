import { executionOrigin } from "./orchestratorExecution.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
/** Live Pathway privileges for work delegated by an AI contact. */
import { makeFunctionReference } from "convex/server";
import type { OrchestratorAssignmentOrigin } from "@spiritdevs/contracts/aiOrchestrator";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { convexHttpClientLike } from "./convexSyncTransport.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import { makeCloudSyncTokenProvider, resolveCloudSyncConfig } from "./syncDaemon.ts";

const WorkerAccess = Schema.Struct({
  allowed: Schema.Boolean,
  capabilities: Schema.Array(Schema.String),
});
const decodeAccess = Schema.decodeUnknownEffect(WorkerAccess);
const accessRef = makeFunctionReference<
  "query",
  OrchestratorAssignmentOrigin & { localProjectId: string | null },
  unknown
>("aiOrchestratorJobs:workerAccess");
export class OrchestratorWorkerPermissionError extends Data.TaggedError(
  "OrchestratorWorkerPermissionError",
)<{ readonly message: string }> {}

export function workerToolCapability(name: string): string | null {
  if (name === "pathway_mail_read") return "mail.read";
  if (name === "pathway_mail_write") return "mail.send";
  if (name === "pathway_time_read") return "time.read";
  if (name === "pathway_time_write") return "time.manage";
  if (name === "pathway_provider_allowance" || name === "pathway_allowance_allocate")
    return "environments.read";
  if (
    ["issues_list", "issues_get", "issues_get_attachment", "issues_milestones_list"].includes(name)
  )
    return "tasks.read";
  if (
    [
      "issues_create",
      "issues_update",
      "issues_comment",
      "issues_comment_evidence",
      "issues_delete",
      "issues_restore",
      "issues_link_thread",
      "issues_milestone_create",
      "issues_milestone_update",
      "issues_milestone_delete",
    ].includes(name)
  )
    return "tasks.manage";
  if (name.startsWith("email_") || name === "resources/read" || name.startsWith("tasks/"))
    return "mail.read";
  if (["delegate_task", "create_threads", "pathway_thread_start"].includes(name))
    return "threads.delegate";
  if (
    [
      "task_cancel",
      "pathway_thread_send",
      "pathway_thread_interrupt",
      "pathway_worktree_handoff",
    ].includes(name)
  )
    return "threads.control";
  if (
    [
      "task_status",
      "pathway_thread_list",
      "pathway_thread_read",
      "pathway_thread_wait",
      "orchestrator_capabilities",
      "pathway_worktree_status",
    ].includes(name)
  )
    return "threads.read";
  if (name.startsWith("preview_")) return "threads.delegate";
  if (
    [
      "schedule_task",
      "update_scheduled_task",
      "delete_scheduled_task",
      "list_scheduled_tasks",
    ].includes(name)
  )
    return "schedules.manage";
  return null;
}

export function checkWorkerToolAccess(
  access: typeof WorkerAccess.Type,
  name: string,
  payload: unknown,
) {
  const capability = workerToolCapability(name);
  if (!access.allowed || !capability || !access.capabilities.includes(capability))
    return "The orchestrator's current permissions do not allow this Pathway action.";
  // Detached schedules and remote launches must be routed through the contact's durable queue.
  if (["schedule_task", "update_scheduled_task"].includes(name))
    return "Ask the coordinating orchestrator to schedule this assignment so it retains its permissions and work limits.";
  if (
    name === "delegate_task" &&
    typeof payload === "object" &&
    payload !== null &&
    "targetEnvironmentId" in payload &&
    payload.targetEnvironmentId
  )
    return "Ask the coordinating orchestrator to delegate this work to that environment.";
  return null;
}

export class OrchestratorWorkerAuthority extends Context.Service<
  OrchestratorWorkerAuthority,
  {
    readonly authorize: (
      invocation: McpInvocationScope,
      name: string,
      payload: unknown,
    ) => Effect.Effect<void, OrchestratorWorkerPermissionError>;
  }
>()("@spiritdevs/pathway/cloud/orchestratorWorkerAuthority") {}

export const layer = Layer.effect(
  OrchestratorWorkerAuthority,
  Effect.gen(function* () {
    const projections = yield* ThreadManagementService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const config = yield* resolveCloudSyncConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const connect = yield* Effect.cached(
      Effect.gen(function* () {
        if (config._tag !== "Configured")
          return yield* new OrchestratorWorkerPermissionError({
            message: "Connect to Pathway Cloud to verify this assignment's permissions.",
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
    return OrchestratorWorkerAuthority.of({
      authorize: (invocation, name, payload) =>
        Effect.gen(function* () {
          if (!invocation.orchestratorOrigin) return;
          const origin = yield* executionOrigin(
            projections.getThreadProjection,
            invocation.threadId,
            invocation.orchestratorOrigin,
          ).pipe(
            Effect.mapError(
              () =>
                new OrchestratorWorkerPermissionError({
                  message: "Could not identify the calling assignment.",
                }),
            ),
          );
          const backend = yield* connect;
          const token = yield* backend.tokens.token;
          const response = yield* backend.lock.withPermits(1)(
            Effect.tryPromise({
              try: () => {
                backend.client.setAuth(token);
                return backend.client.query(accessRef, {
                  ...origin,
                  localProjectId: invocation.projectId ?? null,
                });
              },
              catch: () =>
                new OrchestratorWorkerPermissionError({
                  message:
                    "Pathway could not verify current assignment permissions. Retry when Cloud is available.",
                }),
            }),
          );
          const access = yield* decodeAccess(response);
          const reason = checkWorkerToolAccess(access, name, payload);
          if (reason) return yield* new OrchestratorWorkerPermissionError({ message: reason });
        }).pipe(
          Effect.mapError((error) =>
            error instanceof OrchestratorWorkerPermissionError
              ? error
              : new OrchestratorWorkerPermissionError({
                  message: "Pathway could not verify current assignment permissions.",
                }),
          ),
        ),
    });
  }),
);
