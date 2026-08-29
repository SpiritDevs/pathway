/** Applies authoritative cloud project deletion and repository intents to this environment. */
import type { CloudSyncEntity } from "@spiritdevs/client-runtime/sync";
import {
  CommandId,
  type EnvironmentId,
  ProjectId,
  type Project,
  type RepositoryIdentity,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as ProcessRunner from "../processRunner.ts";

export interface RevokedEnvironmentProject {
  readonly bindingId: string;
  readonly localProjectId: ProjectId;
  readonly updatedAt: number;
}

export interface AuthoritativeEnvironmentRepository {
  readonly bindingId: string;
  readonly localProjectId: ProjectId;
  readonly repositoryIdentity: RepositoryIdentity;
  readonly updatedAt: number;
}

/** Matches the repository resolver's remote preference even before project enrichment completes. */
export function primaryGitRemoteName(
  remoteListing: string,
  enrichedRemoteName?: string,
): { readonly name: string; readonly exists: boolean } | null {
  const all = new Set<string>();
  const fetch = new Set<string>();
  for (const line of remoteListing.split("\n")) {
    const match = /^\s*(\S+)\s+\S+\s+\((fetch|push)\)\s*$/.exec(line);
    if (match === null) continue;
    all.add(match[1]!);
    if (match[2] === "fetch") fetch.add(match[1]!);
  }
  const candidates = fetch.size > 0 ? fetch : all;
  const name =
    (enrichedRemoteName !== undefined && candidates.has(enrichedRemoteName)
      ? enrichedRemoteName
      : undefined) ??
    (["upstream", "origin"].find((candidate) => candidates.has(candidate)) ||
      [...candidates].sort()[0]);
  return name === undefined ? null : { name, exists: all.has(name) };
}

export const authoritativeEnvironmentRepositoryIntentKey = (
  repository: AuthoritativeEnvironmentRepository,
): string =>
  `${repository.bindingId}:${repository.repositoryIdentity.canonicalKey}:${repository.updatedAt}`;

/** Repository choices addressed to one environment by active project bindings. */
export function authoritativeEnvironmentRepositories(
  entities: Iterable<CloudSyncEntity>,
  environmentId: EnvironmentId,
): ReadonlyArray<AuthoritativeEnvironmentRepository> {
  const projects = new Map<string, Extract<CloudSyncEntity, { entityKind: "cloudProject" }>>();
  const bindings: Extract<CloudSyncEntity, { entityKind: "environmentBinding" }>[] = [];
  for (const entity of entities) {
    if (entity.entityKind === "cloudProject") projects.set(String(entity.id), entity);
    if (
      entity.entityKind === "environmentBinding" &&
      entity.environmentId === environmentId &&
      entity.status === "active"
    ) {
      bindings.push(entity);
    }
  }
  return bindings.flatMap((binding) => {
    const project = projects.get(String(binding.cloudProjectId));
    if (project?.repositoryIdentity == null) return [];
    return [
      {
        bindingId: String(binding.id),
        localProjectId: ProjectId.make(String(binding.localProjectId)),
        repositoryIdentity: project.repositoryIdentity,
        updatedAt: Math.max(binding.updatedAt, project.updatedAt),
      },
    ];
  });
}

/** Applies the selected remote to the named checkout without touching files or branches. */
export const reconcileAuthoritativeEnvironmentRepositories = Effect.fn(
  "cloud.project_reconciler.repository",
)(function* (input: {
  readonly repositories: ReadonlyArray<AuthoritativeEnvironmentRepository>;
  readonly projects: ProjectService.ProjectService["Service"];
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
}) {
  if (input.repositories.length === 0) return [];
  const snapshot = yield* input.projects.snapshot;
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const settled: string[] = [];
  for (const repository of input.repositories) {
    const project = projects.get(repository.localProjectId);
    if (project?.workspaceRoot == null) continue;
    const intentKey = authoritativeEnvironmentRepositoryIntentKey(repository);
    if (project.repositoryIdentity?.canonicalKey === repository.repositoryIdentity.canonicalKey) {
      settled.push(intentKey);
      continue;
    }
    const remotes = yield* input.processRunner
      .run({ command: "git", args: ["-C", project.workspaceRoot, "remote", "-v"] })
      .pipe(Effect.option);
    if (remotes._tag === "None" || remotes.value.code !== 0) continue;
    // Apply the URL to this checkout's actual primary fetch remote. The enrichment snapshot can be
    // null just after reconnect, so the live listing is the authority and uses the same preference
    // as RepositoryIdentityResolver: upstream, origin, then alphabetically first.
    const primary = primaryGitRemoteName(
      remotes.value.stdout,
      project.repositoryIdentity?.locator.remoteName,
    );
    const remoteName = primary?.name ?? repository.repositoryIdentity.locator.remoteName;
    const result = yield* input.processRunner
      .run({
        command: "git",
        args: [
          "-C",
          project.workspaceRoot,
          "remote",
          primary?.exists === true ? "set-url" : "add",
          remoteName,
          repository.repositoryIdentity.locator.remoteUrl,
        ],
      })
      .pipe(Effect.option);
    if (result._tag === "Some" && result.value.code === 0) settled.push(intentKey);
  }
  return settled;
});

/** Retries unsettled Git writes without waiting for unrelated cloud state to change. */
export const reconcileAuthoritativeEnvironmentRepositoriesWithRetry = Effect.fn(
  "cloud.project_reconciler.repository_retry",
)(function* (input: {
  readonly repositories: ReadonlyArray<AuthoritativeEnvironmentRepository>;
  readonly projects: ProjectService.ProjectService["Service"];
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly attempts?: number;
  readonly retryDelay?: Duration.Input;
}) {
  const attempts = Math.max(1, input.attempts ?? 5);
  let pending = [...input.repositories];
  const settled = new Set<string>();
  for (let attempt = 0; attempt < attempts && pending.length > 0; attempt += 1) {
    const reconciled = yield* reconcileAuthoritativeEnvironmentRepositories({
      repositories: pending,
      projects: input.projects,
      processRunner: input.processRunner,
    });
    for (const intentKey of reconciled) settled.add(intentKey);
    pending = pending.filter(
      (repository) => !settled.has(authoritativeEnvironmentRepositoryIntentKey(repository)),
    );
    if (pending.length > 0 && attempt + 1 < attempts) {
      yield* Effect.sleep(input.retryDelay ?? Duration.seconds(1));
    }
  }
  return [...settled];
});

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
