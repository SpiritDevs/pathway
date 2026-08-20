/** Cloud discovery fallbacks for Agent Thread projects and thread shells. */
import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import {
  AgentThreadEntity,
  CloudProjectSyncEntity,
  EnvironmentBindingEntity,
  EnvironmentRegistrationEntity,
} from "@spiritdevs/client-runtime/sync";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { normalizeProjectPathForComparison } from "@spiritdevs/shared/path";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { scopedCompanyRegistryReplicasAtom } from "./activeCompany";

const EMPTY_PROJECTS: ReadonlyArray<OrchestrationProjectShell> = Object.freeze([]);
const EMPTY_THREADS: ReadonlyArray<OrchestrationV2ThreadShell> = Object.freeze([]);
const isCloudProject = Schema.is(CloudProjectSyncEntity);
const isEnvironmentBinding = Schema.is(EnvironmentBindingEntity);
const isEnvironmentRegistration = Schema.is(EnvironmentRegistrationEntity);
const isAgentThread = Schema.is(AgentThreadEntity);

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function comparisonPath(value: string, caseInsensitive: boolean): string {
  const normalized = normalizeProjectPathForComparison(value);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function environmentBindingMatchesProject(
  binding: EnvironmentBindingEntity,
  project: Pick<OrchestrationProjectShell, "id" | "workspaceRoot" | "repositoryIdentity"> & {
    readonly environmentId: EnvironmentId;
  },
  caseInsensitivePath: boolean,
): boolean {
  if (binding.environmentId !== project.environmentId) {
    return (
      binding.repositoryIdentity?.canonicalKey !== undefined &&
      binding.repositoryIdentity.canonicalKey === project.repositoryIdentity?.canonicalKey
    );
  }
  if (binding.localProjectId === project.id) return true;
  if (
    binding.repositoryIdentity?.canonicalKey !== undefined &&
    binding.repositoryIdentity.canonicalKey === project.repositoryIdentity?.canonicalKey
  ) {
    return true;
  }
  return (
    project.workspaceRoot !== null &&
    comparisonPath(binding.localWorkspaceRoot, caseInsensitivePath) ===
      comparisonPath(project.workspaceRoot, caseInsensitivePath)
  );
}

export function companyScopedEnvironmentProjects(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  companyId: CompanyId | null,
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
  environmentId: EnvironmentId,
): ReadonlyArray<OrchestrationProjectShell> {
  if (companyId === null) return projects;
  const replica = replicas.get(companyId);
  if (replica === undefined) return EMPTY_PROJECTS;
  const bindings: EnvironmentBindingEntity[] = [];
  let caseInsensitive = false;
  for (const value of replica.view.values()) {
    if (
      isEnvironmentRegistration(value) &&
      value.environmentId === environmentId &&
      (value.descriptor.platform.os === "darwin" || value.descriptor.platform.os === "windows")
    ) {
      caseInsensitive = true;
      continue;
    }
    if (
      isEnvironmentBinding(value) &&
      value.environmentId === environmentId &&
      value.status === "active"
    ) {
      bindings.push(value);
    }
  }
  const filtered = projects.filter((project) =>
    bindings.some((binding) =>
      environmentBindingMatchesProject(binding, { ...project, environmentId }, caseInsensitive),
    ),
  );
  return filtered.length === projects.length ? projects : filtered;
}

export function companyScopedEnvironmentThreads(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  companyId: CompanyId | null,
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
  environmentId: EnvironmentId,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  if (companyId === null) return threads;
  const replica = replicas.get(companyId);
  if (replica === undefined) return EMPTY_THREADS;
  const threadIds = new Set<string>();
  for (const value of replica.view.values()) {
    if (isAgentThread(value) && value.environmentId === environmentId) {
      threadIds.add(value.shell.id);
    }
  }
  const filtered = threads.filter((thread) => threadIds.has(thread.id));
  return filtered.length === threads.length ? threads : filtered;
}

export function companyScopedEnvironmentSnapshot<
  Snapshot extends {
    readonly projects: ReadonlyArray<OrchestrationProjectShell>;
    readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  },
>(
  snapshot: Snapshot,
  companyId: CompanyId | null,
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
  environmentId: EnvironmentId,
): Snapshot {
  const projects = companyScopedEnvironmentProjects(
    snapshot.projects,
    companyId,
    replicas,
    environmentId,
  );
  const threads = companyScopedEnvironmentThreads(
    snapshot.threads,
    companyId,
    replicas,
    environmentId,
  );
  return projects === snapshot.projects && threads === snapshot.threads
    ? snapshot
    : { ...snapshot, projects, threads };
}

export function cloudEnvironmentProjectsFromReplicas(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
  environmentId: EnvironmentId,
): ReadonlyArray<OrchestrationProjectShell> {
  const projects: OrchestrationProjectShell[] = [];
  const seen = new Set<string>();
  for (const replica of replicas.values()) {
    const cloudProjects = new Map(
      [...replica.view.values()]
        .filter(isCloudProject)
        .map((project) => [project.id, project] as const),
    );
    for (const value of replica.view.values()) {
      if (
        !isEnvironmentBinding(value) ||
        value.environmentId !== environmentId ||
        value.status !== "active" ||
        seen.has(value.localProjectId)
      ) {
        continue;
      }
      const project = cloudProjects.get(value.cloudProjectId);
      if (project === undefined || project.archivedAt !== null) continue;
      seen.add(value.localProjectId);
      projects.push({
        id: value.localProjectId,
        title: project.name,
        workspaceRoot: value.localWorkspaceRoot,
        ...(value.repositoryIdentity === undefined
          ? {}
          : { repositoryIdentity: value.repositoryIdentity }),
        defaultModelSelection: null,
        scripts: [],
        createdAt: iso(project.createdAt),
        updatedAt: iso(Math.max(project.updatedAt, value.updatedAt)),
      });
    }
  }
  return projects.length === 0 ? EMPTY_PROJECTS : projects;
}

export const cloudEnvironmentProjectsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<OrchestrationProjectShell> =>
      cloudEnvironmentProjectsFromReplicas(get(scopedCompanyRegistryReplicasAtom), environmentId),
  ).pipe(Atom.withLabel(`cloud-agent-projects:${environmentId}`)),
);

/**
 * Restores the ordinary shell shape for list presentation. The placeholder message text is never
 * rendered as transcript content; opening the thread replaces this fallback from its relay.
 */
export function cloudEnvironmentThreadsFromReplicas(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
  environmentId: EnvironmentId,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const latestByThreadId = new Map<string, AgentThreadEntity>();
  for (const replica of replicas.values()) {
    for (const value of replica.view.values()) {
      if (!isAgentThread(value) || value.environmentId !== environmentId) continue;
      const existing = latestByThreadId.get(value.shell.id);
      if (existing === undefined) {
        latestByThreadId.set(value.shell.id, value);
        continue;
      }
      const shellUpdatedAt = DateTime.toEpochMillis(value.shell.updatedAt);
      const existingShellUpdatedAt = DateTime.toEpochMillis(existing.shell.updatedAt);
      if (
        shellUpdatedAt > existingShellUpdatedAt ||
        (shellUpdatedAt === existingShellUpdatedAt && value.updatedAt > existing.updatedAt)
      ) {
        latestByThreadId.set(value.shell.id, value);
      }
    }
  }

  const threads: OrchestrationV2ThreadShell[] = [];
  for (const value of latestByThreadId.values()) {
    if (value.shell.archivedAt !== null || value.shell.deletedAt !== null) continue;
    threads.push({
      ...value.shell,
      latestVisibleMessage:
        value.shell.latestVisibleMessage === null
          ? null
          : { ...value.shell.latestVisibleMessage, text: "" },
    });
  }
  return threads.length === 0 ? EMPTY_THREADS : threads;
}

export const cloudEnvironmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<OrchestrationV2ThreadShell> =>
      cloudEnvironmentThreadsFromReplicas(get(scopedCompanyRegistryReplicasAtom), environmentId),
  ).pipe(Atom.withLabel(`cloud-agent-threads:${environmentId}`)),
);
