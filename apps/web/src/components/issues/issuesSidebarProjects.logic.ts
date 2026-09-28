/**
 * Which projects the Tasks sidebar lists, and where.
 *
 * The list is for projects that have work in the tracker. Pinned projects stay at the top whatever
 * they hold; a project without tasks waits behind "Show … without tasks" unless it is the one being
 * filtered on; an archived project waits behind "Archived". Searching is asking to see everything,
 * so a query lists every match.
 *
 * @module components/issues/issuesSidebarProjects.logic
 */
import type { IssuesStore } from "~/state/issues";

interface SidebarProject {
  readonly id: string;
  readonly title: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly archived: boolean;
}

export interface IssuesSidebarProjects<Project> {
  readonly pinned: ReadonlyArray<Project>;
  readonly listed: ReadonlyArray<Project>;
  /** Unpinned projects with no tasks, left out of `listed` until the user asks for them. */
  readonly hiddenCount: number;
  readonly archived: ReadonlyArray<Project>;
}

/** Live tasks per project id, triage included: a triage item is work filed under the project. */
export function countIssuesByProject(store: IssuesStore): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const issue of store.issuesById.values()) {
    if (issue.projectId === null || issue.deletedAt !== null) continue;
    counts.set(issue.projectId, (counts.get(issue.projectId) ?? 0) + 1);
  }
  return counts;
}

export function issuesSidebarProjects<Project extends SidebarProject>(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly pinnedIds: ReadonlyArray<string>;
  readonly issueCounts: ReadonlyMap<string, number>;
  /** The project the list is filtered on stays listed, so a selection never hides itself. */
  readonly isActive: (project: Project) => boolean;
  readonly query: string;
  readonly showAll: boolean;
}): IssuesSidebarProjects<Project> {
  const query = input.query.trim().toLowerCase();
  const pinnedIds = new Set(input.pinnedIds);
  const pinned: Project[] = [];
  const listed: Project[] = [];
  const archived: Project[] = [];
  let hiddenCount = 0;
  for (const project of input.projects) {
    if (query !== "" && !project.title.toLowerCase().includes(query)) continue;
    if (project.archived) {
      archived.push(project);
    } else if (pinnedIds.has(project.id)) {
      pinned.push(project);
    } else if (
      query !== "" ||
      input.showAll ||
      input.isActive(project) ||
      project.projectIds.some((projectId) => (input.issueCounts.get(projectId) ?? 0) > 0)
    ) {
      listed.push(project);
    } else {
      hiddenCount += 1;
    }
  }
  return { pinned, listed, hiddenCount, archived };
}
