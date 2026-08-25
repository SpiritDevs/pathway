import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";

interface EmailProjectConnection {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}

interface EmailProjectOption {
  readonly id: ProjectId;
  readonly title: string;
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly environmentProjects: ReadonlyArray<EmailProjectConnection>;
}

export interface EmailSidebarProject {
  /** The stable logical/company project identity used by the row itself. */
  readonly id: ProjectId;
  /** The environment-local id understood by the SMTP capture server. */
  readonly inboxProjectId: ProjectId;
  /** Every local and company id that should make this logical row active. */
  readonly projectIds: ReadonlySet<ProjectId>;
  readonly title: string;
}

/**
 * Projects are company-owned; environment projects are only their connected checkouts. Keep one
 * row per logical project, while retaining the primary environment's local id as the wire handle
 * for the capture inbox and settings APIs.
 */
export function buildEmailSidebarProjects(
  projects: ReadonlyArray<EmailProjectOption>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<EmailSidebarProject> {
  return projects.flatMap((project): ReadonlyArray<EmailSidebarProject> => {
    const inboxConnection =
      project.environmentProjects.find(
        (connection) => connection.environmentId === primaryEnvironmentId,
      ) ?? project.environmentProjects[0];
    if (inboxConnection === undefined) return [];

    return [
      {
        id: project.id,
        inboxProjectId: inboxConnection.id,
        projectIds: new Set([...project.projectIds, inboxConnection.id]),
        title: project.title,
      },
    ];
  });
}
