export function projectGroupTitleNeedsUpdate(
  members: ReadonlyArray<{ readonly title: string; readonly titleIsCustom?: boolean | undefined }>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return (
    wasEdited &&
    members.some((member) => member.title !== nextTitle || member.titleIsCustom !== true)
  );
}
