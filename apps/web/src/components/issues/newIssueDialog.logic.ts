const NEW_ISSUE_DIALOG_MAX_VIEWPORT_RATIO = 0.9;

/** Keeps a project selection only while that project exists in the tracker currently being used. */
export function resolveAvailableIssueProjectId<T extends string>(
  requested: T | null,
  projects: ReadonlyArray<{ readonly id: string }>,
): T | null {
  return requested !== null && projects.some((project) => project.id === requested)
    ? requested
    : null;
}

/** Resolves an environment-local alias to the one logical project choice shown in the dialog. */
export function resolveIssueProjectOptionId<T extends string>(
  requested: T | null,
  projects: ReadonlyArray<{ readonly id: T; readonly projectIds: ReadonlyArray<T> }>,
): T | null {
  if (requested === null) return null;
  return projects.find((project) => project.projectIds.includes(requested))?.id ?? null;
}

/** The resize control is useful only while the dialog is visibly shorter than its height cap. */
export function canResizeNewIssueDialog({
  dialogHeight,
  viewportHeight,
}: {
  dialogHeight: number;
  viewportHeight: number;
}) {
  return dialogHeight + 1 < viewportHeight * NEW_ISSUE_DIALOG_MAX_VIEWPORT_RATIO;
}

export interface IssueCompanyChoice {
  readonly id: string;
  readonly name: string;
}

export interface IssueProjectCompanyGroup<P> {
  /** Null for projects with no company provenance — a purely local checkout. */
  readonly companyId: string | null;
  /** Null when the group needs no heading, which is the single-company case. */
  readonly heading: string | null;
  readonly projects: ReadonlyArray<P>;
}

/**
 * The projects a new issue may be filed against, given the company it is destined for.
 *
 * A project id can be shared by several companies, so narrowing matches on the full owner list
 * rather than the canonical `companyId`, which is deliberately null once an option spans more
 * than one company.
 *
 * An empty owner list means the project carries no company provenance at all — a local checkout
 * seen before any company replica has loaded. Those stay eligible: hiding a project because we do
 * not yet know who owns it empties the whole menu, which is exactly the bug this guard fixes.
 */
export function issueProjectsForCompany<P extends { readonly companyIds: ReadonlyArray<string> }>(
  projects: ReadonlyArray<P>,
  companyId: string | null,
): ReadonlyArray<P> {
  if (companyId === null) return projects;
  return projects.filter(
    (project) => project.companyIds.length === 0 || project.companyIds.includes(companyId),
  );
}

/**
 * Groups the project menu by owning company, for the "no destination chosen yet" case where the
 * flat list would silently mix two workspaces.
 *
 * A project shared by several companies appears under each of them: the menu doubles as the
 * destination picker, so each entry has to name exactly one company to commit to. Companies are
 * listed in registry order and only companies with projects get a heading, so the menu never
 * shows an empty section.
 */
export function groupIssueProjectsByCompany<
  P extends { readonly companyIds: ReadonlyArray<string> },
>(
  projects: ReadonlyArray<P>,
  companies: ReadonlyArray<IssueCompanyChoice>,
): ReadonlyArray<IssueProjectCompanyGroup<P>> {
  const groups: Array<IssueProjectCompanyGroup<P>> = [];
  // One company needs no headings: every project in the menu belongs to it.
  const heading = companies.length > 1;
  for (const company of companies) {
    const owned = projects.filter((project) => project.companyIds.includes(company.id));
    if (owned.length === 0) continue;
    groups.push({
      companyId: company.id,
      heading: heading ? company.name : null,
      projects: owned,
    });
  }
  const unowned = projects.filter((project) => project.companyIds.length === 0);
  if (unowned.length > 0) {
    groups.push({
      companyId: null,
      heading: heading ? "No company" : null,
      projects: unowned,
    });
  }
  return groups;
}
