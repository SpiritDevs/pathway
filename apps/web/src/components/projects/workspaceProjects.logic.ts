/**
 * The Projects workspace list: one entry per logical project, whether or not any machine has a
 * checkout of it.
 *
 * The sidebar used to be derived purely from environment snapshots, which meant a project existed
 * only where its files did. A project is company-owned (ADR 0011) — a checkout is something you
 * attach to it, on as many machines as you like, or never — so a project with no checkout has to
 * be as visible and as selectable as one with three.
 *
 * @module components/projects/workspaceProjects.logic
 */
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { scopedProjectKey } from "@spiritdevs/client-runtime/environment";
import { CloudProjectSyncEntity, EnvironmentBindingEntity } from "@spiritdevs/client-runtime/sync";
import type { RepositoryIdentity, ScopedProjectRef } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";

const isCloudProject = Schema.is(CloudProjectSyncEntity);
const isEnvironmentBinding = Schema.is(EnvironmentBindingEntity);

/** The subset of `IssueProjectOption` this merge needs, so the module stays testable in isolation. */
export interface WorkspaceProjectCandidate {
  readonly id: string;
  readonly title: string;
  readonly companyIds: ReadonlyArray<string>;
  readonly projectIds: ReadonlyArray<string>;
  /** Binding-resolved checkouts; local ids alone may repeat on different environments. */
  readonly environmentProjectRefs?: ReadonlyArray<ScopedProjectRef>;
  readonly isCompanyProject: boolean;
  readonly repositoryIdentity?: RepositoryIdentity | null;
  readonly repositoryIdentities?: ReadonlyArray<RepositoryIdentity>;
}

export interface WorkspaceProject {
  /** Route segment for `/projects/$projectKey`. */
  readonly projectKey: string;
  readonly displayName: string;
  /** Every company that owns this project. Empty while provenance is still unknown. */
  readonly companyIds: ReadonlyArray<string>;
  /** Null when no machine has a checkout — a project you can plan against but not run agents in. */
  readonly group: SidebarProjectSnapshot | null;
  /** How many distinct checkouts back this project. Zero for a company project with no binding. */
  readonly checkoutCount: number;
  /** The company-owned id, when this project has been registered. */
  readonly cloudProjectId: string | null;
  /** Preserves which company owns which id when All Companies folds checkouts into one row. */
  readonly companyProjectIds?: ReadonlyArray<{
    readonly companyId: string;
    readonly cloudProjectId: string;
  }>;
  /** Cloud-level identity remains available when every checkout is offline. */
  readonly repositoryIdentity?: RepositoryIdentity;
  /** Binding-derived choices stay current even when their environments disconnect. */
  readonly repositoryIdentities?: ReadonlyArray<RepositoryIdentity>;
}

export type WorkspaceThreadStartAvailability = "unavailable" | "needs-checkout" | "available";

/**
 * Whether Agent Threads can start from the workspace project catalog.
 *
 * Company projects without a checkout are still actionable: the new-thread picker materialises a
 * checkout when the user selects one. Treating only environment-local groups as available is what
 * made the sidebar list projects while disabling every way to start work in them.
 */
export function workspaceThreadStartAvailability(
  projects: ReadonlyArray<Pick<WorkspaceProject, "group">>,
): WorkspaceThreadStartAvailability {
  if (projects.length === 0) return "unavailable";
  return projects.some((project) => project.group !== null) ? "available" : "needs-checkout";
}

/** Company projects with no checkout need a route key that cannot collide with a grouping key. */
export function cloudProjectKey(cloudProjectId: string): string {
  return `cloud:${cloudProjectId}`;
}

/** The unambiguous cloud-project id owned by one company within a folded workspace row. */
export function workspaceProjectCloudIdForCompany(
  project: WorkspaceProject,
  companyId: string,
): string | null {
  const matches = (project.companyProjectIds ?? []).filter(
    (candidate) => candidate.companyId === companyId,
  );
  if (matches.length === 1) return matches[0]!.cloudProjectId;
  if (
    matches.length === 0 &&
    project.companyIds.length === 1 &&
    project.companyIds[0] === companyId
  ) {
    return project.cloudProjectId;
  }
  return null;
}

/** A merge needs one company and that company's matching project id; All Companies can be ambiguous. */
export function workspaceProjectMergeTarget(
  project: WorkspaceProject,
  scopedCompanyId: string | null,
): { readonly companyId: string; readonly cloudProjectId: string } | null {
  const companyId =
    scopedCompanyId ?? (project.companyIds.length === 1 ? project.companyIds[0]! : null);
  if (companyId === null) return null;
  const cloudProjectId = workspaceProjectCloudIdForCompany(project, companyId);
  return cloudProjectId === null ? null : { companyId, cloudProjectId };
}

/**
 * Merge choices are physical company records, not logical workspace groups. Two cloud projects can
 * already share one repository identity — that is often exactly why the user needs to merge them.
 */
export function buildCompanyProjectMergeCandidates(input: {
  readonly companyId: string;
  readonly targetCloudProjectId: string;
  readonly entities: Iterable<unknown>;
}): ReadonlyArray<WorkspaceProject> {
  const projects: CloudProjectSyncEntity[] = [];
  const bindingsByProject = new Map<string, EnvironmentBindingEntity[]>();
  for (const entity of input.entities) {
    if (isCloudProject(entity)) {
      if (entity.archivedAt === null && String(entity.id) !== input.targetCloudProjectId) {
        projects.push(entity);
      }
      continue;
    }
    if (!isEnvironmentBinding(entity) || entity.status === "revoked") continue;
    const projectId = String(entity.cloudProjectId);
    const bindings = bindingsByProject.get(projectId) ?? [];
    bindings.push(entity);
    bindingsByProject.set(projectId, bindings);
  }

  return projects
    .map((project): WorkspaceProject => {
      const cloudProjectId = String(project.id);
      const bindings = bindingsByProject.get(cloudProjectId) ?? [];
      const repositoryIdentities = bindings
        .flatMap((binding) =>
          binding.repositoryIdentity == null ? [] : [binding.repositoryIdentity],
        )
        .filter(
          (identity, index, identities) =>
            identities.findIndex(
              (candidate) => candidate.canonicalKey === identity.canonicalKey,
            ) === index,
        );
      return {
        projectKey: cloudProjectKey(cloudProjectId),
        displayName: project.name,
        companyIds: [input.companyId],
        group: null,
        checkoutCount: bindings.length,
        cloudProjectId,
        companyProjectIds: [{ companyId: input.companyId, cloudProjectId }],
        ...(project.repositoryIdentity == null
          ? {}
          : { repositoryIdentity: project.repositoryIdentity }),
        ...(repositoryIdentities.length === 0 ? {} : { repositoryIdentities }),
      };
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/**
 * Merges the environment-derived groups with the company's project list.
 *
 * A group wins the display identity when both describe the same project: it carries the favicon,
 * the checkout count, and the grouping label the user has already tuned. The company list
 * contributes ownership, plus the projects no group can describe because nothing is checked out.
 */
export function buildWorkspaceProjects(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly candidates: ReadonlyArray<WorkspaceProjectCandidate>;
}): ReadonlyArray<WorkspaceProject> {
  const groupsByProjectAlias = new Map<string, Set<SidebarProjectSnapshot>>();
  const canonicalGroups = new Map(input.groups.map((group) => [group.projectKey, group]));
  const candidateKeys = (candidate: WorkspaceProjectCandidate) =>
    candidate.environmentProjectRefs === undefined
      ? candidate.projectIds.map((id) => `id:${id}`)
      : candidate.environmentProjectRefs.map((ref) => `ref:${scopedProjectKey(ref)}`);
  for (const group of input.groups) {
    const ids = [
      group.id,
      ...group.memberProjects.map((member) => member.id),
      ...group.memberProjectRefs.map((ref) => ref.projectId),
    ];
    const keys = [
      ...ids.map((id) => `id:${id}`),
      ...group.memberProjectRefs.map((ref) => `ref:${scopedProjectKey(ref)}`),
    ];
    for (const key of keys) {
      const matches = groupsByProjectAlias.get(key) ?? new Set<SidebarProjectSnapshot>();
      matches.add(group);
      groupsByProjectAlias.set(key, matches);
    }
  }

  // Bindings can join checkouts that local grouping keeps apart (different paths, missing Git,
  // or a separate-group preference). Consume all of those groups before adding unclaimed rows.
  for (const candidate of input.candidates) {
    if (!candidate.isCompanyProject) continue;
    const matches = new Set(
      candidateKeys(candidate).flatMap((key) => [...(groupsByProjectAlias.get(key) ?? [])]),
    );
    if (matches.size < 2) continue;
    const groups = [...matches];
    const representative =
      groups.find((group) => group.environmentPresence !== "remote-only") ?? groups[0]!;
    const memberProjects = [
      ...new Map(
        groups.flatMap((group) =>
          group.memberProjects.map((member) => [member.physicalProjectKey, member] as const),
        ),
      ).values(),
    ];
    const memberProjectRefs = [
      ...new Map(
        groups.flatMap((group) =>
          group.memberProjectRefs.map((ref) => [scopedProjectKey(ref), ref] as const),
        ),
      ).values(),
    ];
    const hasLocal = groups.some((group) => group.environmentPresence !== "remote-only");
    const remoteGroups = groups.filter((group) => group.environmentPresence !== "local-only");
    const merged: SidebarProjectSnapshot = {
      ...representative,
      memberProjects,
      memberProjectRefs,
      groupedProjectCount: memberProjects.length,
      environmentPresence: hasLocal
        ? remoteGroups.length > 0
          ? "mixed"
          : "local-only"
        : "remote-only",
      allRemoteMembersAreDesktopLocal:
        remoteGroups.length > 0 &&
        remoteGroups.every((group) => group.allRemoteMembersAreDesktopLocal),
      remoteEnvironmentLabels: [
        ...new Set(groups.flatMap((group) => group.remoteEnvironmentLabels)),
      ],
    };
    // Redirect all aliases, including older checkout ids and groups joined by another company.
    for (const groups of groupsByProjectAlias.values()) {
      let replaced = false;
      for (const group of groups) {
        if (matches.has(group)) {
          groups.delete(group);
          replaced = true;
        }
      }
      if (replaced) groups.add(merged);
    }
    for (const [key, group] of canonicalGroups) {
      if (matches.has(group)) canonicalGroups.set(key, merged);
    }
  }

  const byKey = new Map<string, WorkspaceProject>();
  const claimedGroupKeys = new Set<string>();

  for (const candidate of input.candidates) {
    const group =
      candidateKeys(candidate).flatMap((key) => [...(groupsByProjectAlias.get(key) ?? [])])[0] ??
      null;
    if (group !== null) claimedGroupKeys.add(group.projectKey);

    const projectKey =
      group?.projectKey ??
      (candidate.isCompanyProject ? cloudProjectKey(candidate.id) : String(candidate.id));
    const existing = byKey.get(projectKey);
    const repositoryIdentity =
      candidate.repositoryIdentity ??
      existing?.repositoryIdentity ??
      group?.memberProjects.find((member) => member.repositoryIdentity != null)
        ?.repositoryIdentity ??
      null;
    const repositoryIdentities = [
      ...(existing?.repositoryIdentities ?? []),
      ...(candidate.repositoryIdentities ?? []),
    ].filter(
      (identity, index, identities) =>
        identities.findIndex((candidate) => candidate.canonicalKey === identity.canonicalKey) ===
        index,
    );
    const companyProjectIds = [
      ...(existing?.companyProjectIds ?? []),
      ...(candidate.isCompanyProject
        ? candidate.companyIds.map((companyId) => ({ companyId, cloudProjectId: candidate.id }))
        : []),
    ].filter(
      (mapping, index, mappings) =>
        mappings.findIndex(
          (candidate) =>
            candidate.companyId === mapping.companyId &&
            candidate.cloudProjectId === mapping.cloudProjectId,
        ) === index,
    );
    // The same project id can arrive once per owning company. Keep one row and union the owners,
    // so a shared project is listed once rather than once per company.
    byKey.set(projectKey, {
      projectKey,
      displayName: group?.displayName ?? candidate.title,
      companyIds: [...new Set([...(existing?.companyIds ?? []), ...candidate.companyIds])],
      group,
      checkoutCount: group?.groupedProjectCount ?? 0,
      cloudProjectId: candidate.isCompanyProject
        ? candidate.id
        : (existing?.cloudProjectId ?? null),
      ...(companyProjectIds.length === 0 ? {} : { companyProjectIds }),
      ...(repositoryIdentity === null ? {} : { repositoryIdentity }),
      ...(repositoryIdentities.length === 0 ? {} : { repositoryIdentities }),
    });
  }

  // A checkout nobody has registered yet still belongs in the list. Dropping it here would repeat
  // the mistake that emptied the issue Project picker.
  for (const group of input.groups) {
    const canonicalGroup = canonicalGroups.get(group.projectKey) ?? group;
    if (claimedGroupKeys.has(canonicalGroup.projectKey) || byKey.has(canonicalGroup.projectKey))
      continue;
    const repositoryIdentity = group.memberProjects.find(
      (member) => member.repositoryIdentity != null,
    )?.repositoryIdentity;
    const repositoryIdentities = group.memberProjects
      .map((member) => member.repositoryIdentity)
      .filter((identity): identity is RepositoryIdentity => identity != null)
      .filter(
        (identity, index, identities) =>
          identities.findIndex((candidate) => candidate.canonicalKey === identity.canonicalKey) ===
          index,
      );
    byKey.set(group.projectKey, {
      projectKey: group.projectKey,
      displayName: group.displayName,
      companyIds: [],
      group,
      checkoutCount: group.groupedProjectCount,
      cloudProjectId: null,
      ...(repositoryIdentity == null ? {} : { repositoryIdentity }),
      ...(repositoryIdentities.length === 0 ? {} : { repositoryIdentities }),
    });
  }

  return [...byKey.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

/** The projects still waiting for someone to say which company owns them. */
export function unassignedWorkspaceProjects(
  projects: ReadonlyArray<WorkspaceProject>,
): ReadonlyArray<WorkspaceProject> {
  return projects.filter((project) => project.companyIds.length === 0);
}

/** A dismissal belongs to these checkout records, not every future project at the same path. */
export function workspaceProjectAssignmentKey(
  project: Pick<WorkspaceProject, "projectKey" | "group">,
): string {
  const checkoutKeys = (project.group?.memberProjects ?? [])
    .map((checkout) => `${checkout.environmentId}:${checkout.id}`)
    .sort();
  return JSON.stringify([project.projectKey, checkoutKeys]);
}
