import { ProjectId, type EnvironmentId } from "@spiritdevs/contracts";

import type { SidebarProjectGroupMember } from "~/sidebarProjectGrouping";
import type { WorkspaceProject } from "../projects/workspaceProjects.logic";

export interface SourceControlProjectEntry {
  readonly project: WorkspaceProject;
  /** Stable company id when Convex owns the project, otherwise the representative local id. */
  readonly projectId: ProjectId;
  /** Preferred checkout for the row's favicon. */
  readonly targetProject: SidebarProjectGroupMember | null;
  /** At most one rooted checkout per environment, used to fan source-control reads out. */
  readonly targetProjects: ReadonlyArray<SidebarProjectGroupMember>;
}

/**
 * Keeps the Convex company project list intact while retaining one usable checkout per environment.
 * The primary environment only decides which checkout supplies the row's presentation; it no longer
 * narrows the project or its pull requests to one machine.
 */
export function sourceControlProjectEntries(
  projects: ReadonlyArray<WorkspaceProject>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<SourceControlProjectEntry> {
  return projects.map((project) => {
    const candidates =
      project.group?.memberProjects.filter((member) => member.workspaceRoot !== null) ?? [];
    const targetProjects = [
      ...new Map(candidates.map((member) => [member.environmentId, member] as const)).values(),
    ];
    const targetProject =
      targetProjects.find((member) => member.environmentId === primaryEnvironmentId) ??
      targetProjects.find((member) => member.id === project.group?.id) ??
      targetProjects[0] ??
      null;
    return {
      project,
      projectId: ProjectId.make(
        project.cloudProjectId ?? String(project.group?.id ?? project.projectKey),
      ),
      targetProject,
      targetProjects,
    };
  });
}

/** Accepts old environment-local links as aliases for the Convex-owned project id. */
export function findSourceControlProjectEntry(
  entries: ReadonlyArray<SourceControlProjectEntry>,
  projectId: ProjectId | undefined,
): SourceControlProjectEntry | null {
  if (projectId === undefined) return null;
  return (
    entries.find(
      (entry) =>
        entry.projectId === projectId ||
        entry.targetProjects.some((project) => project.id === projectId),
    ) ?? null
  );
}

export interface PullRequestProjectSearch {
  readonly involvement: "all" | "reviewing" | "authored";
  readonly state: "all" | "open" | "closed" | "merged";
  readonly projectId?: ProjectId;
  readonly host?: string;
  readonly q?: string;
}

/** Project navigation starts a fresh list selection while retaining the other list filters. */
export function pullRequestProjectSearch(
  raw: Record<string, unknown>,
  projectId: ProjectId | undefined,
): PullRequestProjectSearch {
  const involvement =
    raw.involvement === "reviewing" || raw.involvement === "authored" ? raw.involvement : "all";
  const state =
    raw.state === "closed" || raw.state === "merged" || raw.state === "all" ? raw.state : "open";
  return {
    involvement,
    state,
    ...(projectId === undefined ? {} : { projectId }),
    ...(typeof raw.host === "string" && raw.host ? { host: raw.host.slice(0, 200) } : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
  };
}
