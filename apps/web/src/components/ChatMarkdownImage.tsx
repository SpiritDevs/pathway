import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { createContext, useContext, useState } from "react";
import type { Components } from "react-markdown";

import { useAssetUrlState } from "../assets/assetUrls";
import { resolveMarkdownImageSource } from "../markdown-images";
import { ImageLightbox } from "./media/ImageLightbox";

export const MarkdownLinkedImageContext = createContext(false);

export const MarkdownImageContext = createContext<{
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly cwd?: string | undefined;
}>({});

function UnavailableImage({
  alt,
  retry,
}: {
  readonly alt: string;
  readonly retry?: (() => void) | undefined;
}) {
  return (
    <span
      className="my-2 inline-flex max-w-full flex-col gap-1 rounded-md border p-3 text-sm"
      role="status"
    >
      <span>{alt || "Image"}</span>
      <span className="text-xs text-muted-foreground">
        Image unavailable. Check the environment connection and file access.
      </span>
      {retry && (
        <button
          type="button"
          className="self-start text-xs underline"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            retry();
          }}
        >
          Retry image
        </button>
      )}
    </span>
  );
}

function ImageContent({
  url,
  source,
  alt,
  retry,
}: {
  readonly url: string;
  readonly source: string;
  readonly alt: string;
  readonly retry?: (() => void) | undefined;
}) {
  const linked = useContext(MarkdownLinkedImageContext);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (failed) return <UnavailableImage alt={alt} retry={retry} />;
  return (
    <span className="my-2 inline-block max-w-full align-middle">
      {!loaded && (
        <span className="block text-xs text-muted-foreground" role="status">
          Loading {alt || "image"}…
        </span>
      )}
      <img
        src={url}
        data-markdown-src={source}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="h-auto max-h-[32rem] max-w-full object-contain"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
      {loaded && !linked && (
        <button
          type="button"
          className="mt-1 block text-xs text-muted-foreground underline"
          onClick={() => setExpanded(true)}
        >
          Open image
        </button>
      )}
      {expanded && (
        <ImageLightbox
          images={[{ src: url, name: alt || "Image" }]}
          onClose={() => setExpanded(false)}
          onImageError={() => {
            setExpanded(false);
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}

function WorkspaceMarkdownImage({
  threadRef,
  path,
  source,
  alt,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly source: string;
  readonly alt: string;
}) {
  const asset = useAssetUrlState(threadRef.environmentId, {
    _tag: "workspace-file",
    threadId: threadRef.threadId,
    path,
  });
  if (asset._tag === "Failure") return <UnavailableImage alt={alt} retry={asset.refresh} />;
  if (asset._tag === "Loading")
    return (
      <span role="status" className="text-xs text-muted-foreground">
        Loading {alt || "image"}…
      </span>
    );
  return (
    <ImageContent key={asset.url} url={asset.url} source={source} alt={alt} retry={asset.refresh} />
  );
}

// A stable renderer keeps mounted asset queries alive as the surrounding message streams.
export const ChatMarkdownImage: NonNullable<Components["img"]> = function ChatMarkdownImage({
  src,
  alt = "",
}) {
  const { threadRef, cwd } = useContext(MarkdownImageContext);
  const source = resolveMarkdownImageSource(typeof src === "string" ? src : "", cwd);
  if (source.kind === "web")
    return <ImageContent key={source.url} url={source.url} source={source.url} alt={alt} />;
  if (source.kind === "unavailable" || !threadRef) return <UnavailableImage alt={alt} />;
  return (
    <WorkspaceMarkdownImage
      key={JSON.stringify([threadRef.environmentId, threadRef.threadId, source.path])}
      threadRef={threadRef}
      path={source.path}
      source={typeof src === "string" ? src : ""}
      alt={alt}
    />
  );
};
