const NEW_ISSUE_DIALOG_MAX_VIEWPORT_RATIO = 0.9;

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
