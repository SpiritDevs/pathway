import type { Asset } from "@spiritdevs/contracts/assets";
import type { ConvexClient } from "convex/browser";
import { DownloadIcon, ExpandIcon, FileIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { assetFunctions } from "../../cloud/assetClient";
import { ImageLightbox } from "../media/ImageLightbox";
import { Button } from "../ui/button";
import "./assetMedia.css";

export function assetStatus(asset: Asset): string {
  if (asset.state === "trashed" || asset.state === "purged") return "Asset deleted";
  if (asset.state === "uploading") return "Uploading";
  if (asset.state === "failed") return asset.error || "Upload failed";
  if (asset.previewState === "pending") return "Preparing preview";
  if (asset.previewState === "failed") return "Preview failed. Original available.";
  if (asset.previewState === "unsupported") return "Original available to download";
  return "Ready";
}

const revealedImages = new Set<string>();

export function AssetMedia({
  asset,
  client,
  onGallery,
}: {
  asset: Asset;
  client: ConvexClient;
  onGallery?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(() => revealedImages.has(asset.id));
  const [poster, setPoster] = useState<string | undefined>(undefined);
  const [retry, setRetry] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const media = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const shown = entries.some((entry) => entry.isIntersecting);
        if (shown) setVisible(true);
        else media.current?.pause();
      },
      { rootMargin: "0px" },
    );
    if (root.current) observer.observe(root.current);
    const pause = () => {
      if (document.hidden) media.current?.pause();
    };
    document.addEventListener("visibilitychange", pause);
    return () => {
      observer.disconnect();
      media.current?.pause();
      document.removeEventListener("visibilitychange", pause);
    };
  }, []);
  useEffect(() => {
    if (
      !visible ||
      asset.previewState !== "ready" ||
      !asset.originalReady ||
      asset.state === "trashed" ||
      asset.state === "purged"
    )
      return;
    let active = true;
    setError(null);
    if (asset.kind === "video")
      void client
        .mutation(assetFunctions.resolve, {
          companyId: asset.companyId,
          assetId: asset.id,
          representation: "poster",
        })
        .then(
          (result) => {
            if (active) setPoster(result.url);
          },
          () => {
            /* The original may not have a poster yet. */
          },
        );
    void client
      .mutation(assetFunctions.resolve, {
        companyId: asset.companyId,
        assetId: asset.id,
        representation: "preview",
      })
      .then(
        (result) => {
          if (active) setUrl(result.url);
        },
        (reason) => {
          if (active) setError(reason instanceof Error ? reason.message : "Preview unavailable");
        },
      );
    return () => {
      active = false;
    };
  }, [
    client,
    asset.id,
    asset.companyId,
    asset.previewState,
    asset.originalReady,
    asset.state,
    asset.kind,
    visible,
    retry,
  ]);
  const download = async () => {
    try {
      const result = await client.mutation(assetFunctions.resolve, {
        companyId: asset.companyId,
        assetId: asset.id,
        representation: "original",
      });
      const anchor = document.createElement("a");
      anchor.href = result.url;
      anchor.download = asset.name;
      anchor.rel = "noopener";
      anchor.click();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Download failed");
    }
  };
  const deleted = asset.state === "trashed" || asset.state === "purged";
  return (
    <span
      ref={root}
      className="my-2 block overflow-hidden rounded-xl border bg-muted/20"
      aria-label={asset.name}
    >
      {!deleted && asset.kind === "image" && (
        <span className="asset-image-frame block aspect-video bg-muted">
          {url && (
            <button
              type="button"
              className="block size-full"
              onClick={onGallery}
              aria-label={`Open ${asset.name} in gallery`}
            >
              <img
                src={url}
                alt={asset.name}
                loading="lazy"
                decoding="async"
                onLoad={() => {
                  setLoaded(true);
                  revealedImages.add(asset.id);
                  if (revealedImages.size > 256) {
                    const oldest = revealedImages.values().next().value;
                    if (oldest) revealedImages.delete(oldest);
                  }
                }}
                onError={() => setError("Image could not be loaded")}
                data-loaded={loaded}
                className="asset-reveal size-full object-contain"
              />
            </button>
          )}
          {!loaded && !error && <span className="sr-only">Loading image</span>}
        </span>
      )}
      {!deleted && asset.kind === "video" && (
        <video
          ref={media as React.RefObject<HTMLVideoElement>}
          src={url ?? undefined}
          poster={poster}
          controls={Boolean(url)}
          playsInline
          preload="none"
          aria-label={asset.name}
          onError={() => setError("Video could not be loaded")}
          className="aspect-video w-full bg-black"
        />
      )}
      {!deleted && asset.kind === "audio" && (
        <audio
          ref={media as React.RefObject<HTMLAudioElement>}
          src={url ?? undefined}
          controls={Boolean(url)}
          preload="none"
          aria-label={asset.name}
          className="w-full"
        />
      )}
      <span className="flex items-center gap-2 p-3 text-sm">
        <FileIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{asset.name}</span>
          <span className="block text-xs text-muted-foreground">{assetStatus(asset)}</span>
        </span>
        {onGallery &&
          !deleted &&
          asset.previewState === "ready" &&
          (asset.kind === "image" || asset.kind === "video") && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Open gallery"
              onClick={() => {
                media.current?.pause();
                onGallery();
              }}
            >
              <ExpandIcon className="size-4" />
            </Button>
          )}
        {asset.originalReady && !deleted && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Download ${asset.name}`}
            onClick={() => void download()}
          >
            <DownloadIcon className="size-4" />
          </Button>
        )}
      </span>
      {error && (
        <span role="alert" className="block px-3 pb-3 text-sm text-destructive">
          {error}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setUrl(null);
              setRetry((value) => value + 1);
            }}
          >
            Retry
          </button>
        </span>
      )}
    </span>
  );
}

export function AssetGallery({
  assets,
  selectedId,
  client,
  onClose,
  onLoadMore,
}: {
  assets: Asset[];
  selectedId: string;
  client: ConvexClient;
  onClose: () => void;
  onLoadMore?: () => Promise<void>;
}) {
  const items = assets.filter(
    (asset) =>
      (asset.kind === "image" || asset.kind === "video") &&
      asset.previewState === "ready" &&
      asset.state !== "trashed" &&
      asset.state !== "purged",
  );
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ids = items.map((item) => item.id).join("\n");
  useEffect(() => {
    let active = true;
    // Metadata is small; bytes remain lazily loaded by the lightbox.
    void Promise.all(
      items.map(async (asset) => {
        const result = await client.mutation(assetFunctions.resolve, {
          companyId: asset.companyId,
          assetId: asset.id,
          representation: "preview",
        });
        return [asset.id, result.url] as const;
      }),
    ).then(
      (entries) => {
        if (active) setUrls(Object.fromEntries(entries));
      },
      (reason) => {
        if (active) setFailure(reason instanceof Error ? reason.message : "Gallery unavailable");
      },
    );
    return () => {
      active = false;
    };
  }, [client, ids]);
  if (failure)
    return (
      <span role="alert">
        {failure}{" "}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </span>
    );
  return (
    <ImageLightbox
      images={items.map((asset) => ({
        kind: asset.kind === "video" ? "video" : "image",
        src: urls[asset.id] ?? "",
        name: asset.name,
        loading: !urls[asset.id],
      }))}
      initialIndex={Math.max(
        0,
        items.findIndex((asset) => asset.id === selectedId),
      )}
      actions={
        onLoadMore
          ? [
              {
                id: "more-assets",
                label: loadingMore ? "Loading…" : "Load more files",
                icon: PlusIcon,
                disabled: loadingMore,
                onSelect: () => {
                  setLoadingMore(true);
                  void onLoadMore()
                    .catch((reason) =>
                      setFailure(
                        reason instanceof Error ? reason.message : "Could not load more files",
                      ),
                    )
                    .finally(() => setLoadingMore(false));
                },
              },
            ]
          : []
      }
      onClose={onClose}
    />
  );
}
