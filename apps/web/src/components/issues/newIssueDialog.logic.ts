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
