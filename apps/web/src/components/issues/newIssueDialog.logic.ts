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

/**
 * The projects a new issue may be filed against, given the company it is destined for.
 *
 * Narrowing matches the recorded owner list so older replicated options still resolve while the
 * canonical project owner drives new selections.
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
