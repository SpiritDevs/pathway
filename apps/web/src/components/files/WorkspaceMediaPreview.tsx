import type { EnvironmentId, ScopedThreadRef } from "@spiritdevs/contracts";
import { isWorkspaceVideoPreviewPath } from "@spiritdevs/shared/filePreview";
import { DownloadIcon, ExpandIcon, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { ImageLightbox, type LightboxImage } from "../media/ImageLightbox";
import { imageDownloadFileName } from "../media/imageLightbox.logic";
import { downloadImageFile } from "../media/imageTransfer";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function WorkspaceMediaPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly alt: string;
}) {
  const isVideo = isWorkspaceVideoPreviewPath(props.absolutePath);
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  if (assetUrl._tag === "Failure") {
    return (
      <p role="status" className="m-auto p-6 text-xs text-destructive">
        Unable to load workspace media.
      </p>
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  const media: LightboxImage = {
    name: props.absolutePath.split(/[\\/]/).pop() ?? props.alt,
    src: assetUrl.url,
    kind: isVideo ? "video" : "image",
  };
  const download = () => {
    setDownloading(true);
    void downloadImageFile(media.src, imageDownloadFileName(media.name, media.src))
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not download the file",
            description: error instanceof Error ? error.message : "Please try again.",
          }),
        );
      })
      .finally(() => setDownloading(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {galleryOpen ? null : failedUrl === assetUrl.url ? (
          <p role="status" className="text-center text-xs text-destructive">
            {isVideo
              ? "This video could not be played. You can download it to play in another app."
              : "Unable to load workspace image."}
          </p>
        ) : isVideo ? (
          <video
            key={assetUrl.url}
            aria-label={props.alt}
            className="max-h-full max-w-full object-contain"
            src={assetUrl.url}
            controls
            playsInline
            preload="metadata"
            onError={() => setFailedUrl(assetUrl.url)}
          />
        ) : (
          <img
            className="max-h-full max-w-full object-contain"
            src={assetUrl.url}
            alt={props.alt}
            onError={() => setFailedUrl(assetUrl.url)}
          />
        )}
      </div>
      <div className="flex shrink-0 justify-center gap-2 p-3">
        <Button size="sm" variant="outline" onClick={() => setGalleryOpen(true)}>
          <ExpandIcon />
          Open gallery
        </Button>
        <Button size="sm" variant="outline" disabled={downloading} onClick={download}>
          <DownloadIcon />
          Download
        </Button>
      </div>
      {galleryOpen ? (
        <ImageLightbox images={[media]} onClose={() => setGalleryOpen(false)} />
      ) : null}
    </div>
  );
}
