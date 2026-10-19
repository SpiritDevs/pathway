import type { SnapShotSource } from "@spiritdevs/contracts";

export interface ExpandedImageItem {
  src: string;
  name: string;
  source?: SnapShotSource | undefined;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<{
    id: string;
    name: string;
    previewUrl?: string;
    source?: SnapShotSource | undefined;
  }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    image.previewUrl
      ? [{ id: image.id, src: image.previewUrl, name: image.name, source: image.source }]
      : [],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({
      src: image.src,
      name: image.name,
      ...(image.source?.kind === "snap-shot" ? { source: image.source } : {}),
    })),
    index: selectedIndex,
  };
}
