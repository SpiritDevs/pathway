import type { PreviewSessionSnapshot, ProjectScript } from "@spiritdevs/contracts";

export function shouldShowPreviewEmptyState(
  snapshot: PreviewSessionSnapshot | null,
  nativePopup = false,
): boolean {
  return snapshot === null || (snapshot.navStatus._tag === "Idle" && !nativePopup);
}

export function getConfiguredPreviewUrls(
  scripts: ReadonlyArray<ProjectScript> | undefined,
): ReadonlyArray<string> {
  return scripts?.flatMap((script) => (script.previewUrl ? [script.previewUrl] : [])) ?? [];
}
