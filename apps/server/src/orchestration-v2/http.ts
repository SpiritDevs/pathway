import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type OrchestrationProjectShell,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { makeThreadAccessRequest } from "../conversationSharing/ThreadAccess.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

/**
 * Serves orchestration V2 snapshots over HTTP so clients can load the
 * (potentially large) shell and thread projections off the socket — gzip
 * compressible and cacheable — and then resume the WebSocket subscription via
 * `afterSequence`.
 */
export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const environment = yield* ServerEnvironment;

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use immediately available enrichment only. Awaiting git-backed
            // identity resolution can exceed the client shell-snapshot budget
            // (ProcessRunner allows probes up to one minute). Background workers
            // plus the WS enrichment subscription fill in repositoryIdentity.
            project.workspaceRoot === null
              ? Effect.succeed({ ...project, repositoryIdentity: null })
              : projectEnrichment.getAvailable(project.workspaceRoot).pipe(
                  Effect.map((enrichment) => ({
                    ...project,
                    repositoryIdentity: enrichment.repositoryIdentity,
                  })),
                ),
          { concurrency: 16 },
        ),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(function* (includeProjects: boolean) {
      const base = yield* sql.withTransaction(
        Effect.gen(function* () {
          const projects = yield* projectionSnapshotQuery.getShellSnapshotWithoutEnrichment();
          const threads = yield* threadManagement.getShellSnapshot();
          return {
            schemaVersion: threads.schemaVersion,
            snapshotSequence: yield* applicationEvents.latestApplicationSequence,
            projects: projects.projects,
            threads: threads.threads,
            archivedThreads: threads.archivedThreads,
          } as const;
        }),
      );
      const projects = includeProjects ? yield* enrichProjectShells(base.projects) : [];
      return { ...base, projects };
    });

    return handlers
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const access = yield* makeThreadAccessRequest(
            { ...session, scopes: [...session.scopes] },
            yield* environment.getEnvironmentId,
          );
          const snapshot = yield* loadShellSnapshot(!access.restricted).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
          return {
            ...snapshot,
            projects: access.restricted ? [] : snapshot.projects,
            threads: snapshot.threads.filter((thread) => access.canAccess(thread, "read")),
            archivedThreads: snapshot.archivedThreads.filter((thread) =>
              access.canAccess(thread, "read"),
            ),
          };
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const access = yield* makeThreadAccessRequest(
            { ...session, scopes: [...session.scopes] },
            yield* environment.getEnvironmentId,
          );
          const snapshot = yield* threadManagement.getThreadSnapshot(args.params.threadId).pipe(
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal(
                  "orchestration_thread_snapshot_failed",
                  error,
                );
              }),
            ),
          );
          if (!access.canAccess(snapshot.projection.thread, "read"))
            return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          };
        }),
      );
  }),
);
