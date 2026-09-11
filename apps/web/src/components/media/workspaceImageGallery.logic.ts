import { isWorkspaceMediaPreviewPath } from "@spiritdevs/shared/filePreview";
import type { MarkdownFileLinkMeta } from "~/markdown-links";

export function buildMarkdownImageGallery(
  selectedPath: string,
  links: Iterable<MarkdownFileLinkMeta>,
) {
  const paths = new Set<string>();
  for (const link of links) {
    if (link.workspaceRelativePath && isWorkspaceMediaPreviewPath(link.workspaceRelativePath)) {
      paths.add(link.workspaceRelativePath);
    }
  }
  paths.add(selectedPath);
  const galleryPaths = [...paths];
  return { paths: galleryPaths, initialIndex: galleryPaths.indexOf(selectedPath) };
}
