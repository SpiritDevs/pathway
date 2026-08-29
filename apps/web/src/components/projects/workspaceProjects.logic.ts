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
import type { RepositoryIdentity } from "@spiritdevs/contracts";

/** The subset of `IssueProjectOption` this merge needs, so the module stays testable in isolation. */
export interface WorkspaceProjectCandidate {
  readonly id: string;
  readonly title: string;
  readonly companyIds: ReadonlyArray<string>;
  readonly projectIds: ReadonlyArray<string>;
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
  const groupByProjectId = new Map<string, SidebarProjectSnapshot>();
  for (const group of input.groups) {
    groupByProjectId.set(String(group.id), group);
    for (const member of group.memberProjects) groupByProjectId.set(String(member.id), group);
  }

  const byKey = new Map<string, WorkspaceProject>();
  const claimedGroupKeys = new Set<string>();

  for (const candidate of input.candidates) {
    const group =
      candidate.projectIds
        .map((projectId) => groupByProjectId.get(String(projectId)))
        .find((match) => match !== undefined) ?? null;
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
      ...(repositoryIdentity === null ? {} : { repositoryIdentity }),
      ...(repositoryIdentities.length === 0 ? {} : { repositoryIdentities }),
    });
  }

  // A checkout nobody has registered yet still belongs in the list. Dropping it here would repeat
  // the mistake that emptied the issue Project picker.
  for (const group of input.groups) {
    if (claimedGroupKeys.has(group.projectKey) || byKey.has(group.projectKey)) continue;
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
