/** Applies authoritative cloud project deletions to this environment's local event store. */
import type { CloudSyncEntity } from "@spiritdevs/client-runtime/sync";
import { CommandId, type EnvironmentId, ProjectId, type Project } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";

import type { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type * as ProjectService from "../project/ProjectService.ts";

export interface RevokedEnvironmentProject {
  readonly bindingId: string;
  readonly localProjectId: ProjectId;
  readonly updatedAt: number;
}

export const revokedEnvironmentProjectIntentKey = (binding: RevokedEnvironmentProject): string =>
  `${binding.bindingId}:${binding.updatedAt}`;

/** The durable delete intents addressed to one environment in a confirmed company replica. */
export function revokedEnvironmentProjects(
  entities: Iterable<CloudSyncEntity>,
  environmentId: EnvironmentId,
): ReadonlyArray<RevokedEnvironmentProject> {
  const byProject = new Map<ProjectId, RevokedEnvironmentProject>();
  for (const entity of entities) {
    if (
      entity.entityKind !== "environmentBinding" ||
      entity.environmentId !== environmentId ||
      entity.status !== "revoked"
    ) {
      continue;
    }
    const localProjectId = ProjectId.make(String(entity.localProjectId));
    const current = byProject.get(localProjectId);
    if (current === undefined || entity.updatedAt > current.updatedAt) {
      byProject.set(localProjectId, {
        bindingId: String(entity.id),
        localProjectId,
        updatedAt: entity.updatedAt,
      });
    }
  }
  return [...byProject.values()];
}

/**
 * Deletes live local projects whose confirmed bindings Convex revoked.
 *
 * `force` is intentional: deleting the company project means deleting its local threads too, and
 * the orchestration decider already turns this one command into the ordered thread/project event
 * sequence. Files on disk remain untouched.
 */
export const reconcileRevokedEnvironmentProjects = Effect.fn("cloud.project_reconciler.reconcile")(
  function* (input: {
    readonly companyId: CompanyId;
    readonly environmentId: EnvironmentId;
    readonly revoked: ReadonlyArray<RevokedEnvironmentProject>;
    readonly projects: ProjectService.ProjectService["Service"];
    readonly orchestration: OrchestrationEngineService["Service"];
  }) {
    if (input.revoked.length === 0) return [];

    const snapshot = yield* input.projects.snapshot;
    const live = new Map<Project["id"], Project>(
      snapshot.projects.map((project) => [project.id, project]),
    );
    const reconciled = yield* Effect.forEach(
      input.revoked,
      (binding) => {
        const intentKey = revokedEnvironmentProjectIntentKey(binding);
        if (!live.has(binding.localProjectId)) return Effect.succeed(intentKey);
        return input.orchestration
          .dispatch({
            type: "project.delete",
            commandId: CommandId.make(
              `cloud-project-delete:${input.companyId}:${binding.bindingId}:${binding.updatedAt}`,
            ),
            projectId: binding.localProjectId,
            force: true,
          })
          .pipe(
            Effect.as(intentKey),
            Effect.catchCause((cause) =>
              Effect.logWarning("Cloud project deletion could not be applied locally", {
                companyId: input.companyId,
                environmentId: input.environmentId,
                projectId: binding.localProjectId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
      },
      { concurrency: 1 },
    );
    return reconciled.filter((intentKey): intentKey is string => intentKey !== null);
  },
);
