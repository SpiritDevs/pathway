import { useWorkspaceAssetPublishAction } from "../assets/useWorkspaceAssetPublishAction";
import { isWorkspaceVideoPreviewPath } from "@spiritdevs/shared/filePreview";
import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { useEffect, useState } from "react";

import { resolveAssetUrl } from "@spiritdevs/client-runtime/state/assets";
import { assetEnvironment } from "~/state/assets";
import { projectEnvironment } from "~/state/projects";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "~/workspaceBasenameLookup";
import { ImageLightbox, type LightboxImage } from "./ImageLightbox";

/** Signed URLs are requested only while the gallery is open, from the thread's environment. */
export function WorkspaceImageGallery({
  paths,
  initialIndex,
  cwd,
  threadRef,
  onClose,
}: {
  paths: ReadonlyArray<string>;
  initialIndex: number;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const connection = usePreparedConnection(threadRef.environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const searchEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const [images, setImages] = useState<ReadonlyArray<LightboxImage>>(() =>
    paths.map((path) => ({
      name: path.split(/[\\/]/).pop() ?? path,
      kind: isWorkspaceVideoPreviewPath(path) ? "video" : "image",
      src: "",
      loading: true,
    })),
  );

  const [resolvedPaths] = useState(() => new Map<number, string>());
  const publishActions = useWorkspaceAssetPublishAction(threadRef, async (index) => {
    const path = resolvedPaths.get(index);
    if (!path || !httpBaseUrl)
      throw new Error("Connect to the environment and load the original file first.");
    const result = await createAssetUrl({
      environmentId: threadRef.environmentId,
      input: { resource: { _tag: "workspace-file", threadId: threadRef.threadId, path } },
    });
    if (result._tag !== "Success") throw new Error("The original file is unavailable.");
    const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error("The original file is unavailable.");
    return url;
  });
  useEffect(() => {
    let cancelled = false;
    const load = async (originalPath: string) => {
      if (httpBaseUrl === null) throw new Error("The environment is not connected.");
      let path = originalPath;
      if (cwd && needsWorkspaceBasenameLookup(path)) {
        const result = await searchEntries({
          environmentId: threadRef.environmentId,
          input: { cwd, query: path, limit: WORKSPACE_BASENAME_LOOKUP_LIMIT, kind: "file" },
        });
        if (result._tag === "Success") {
          path = pickWorkspaceBasenameMatch(path, result.value.entries) ?? path;
        }
      }
      const result = await createAssetUrl({
        environmentId: threadRef.environmentId,
        input: { resource: { _tag: "workspace-file", threadId: threadRef.threadId, path } },
      });
      if (result._tag !== "Success") throw new Error("This media file is unavailable.");
      const src = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
      if (!src) throw new Error("This media file is unavailable.");
      return { src, path };
    };
    paths.forEach((path, index) => {
      void load(path).then(
        ({ src, path: resolvedPath }) => {
          if (cancelled) return;
          resolvedPaths.set(index, resolvedPath);
          setImages((current) =>
            current.map((image, i) => (i === index ? { ...image, src, loading: false } : image)),
          );
        },
        () => {
          if (cancelled) return;
          setImages((current) =>
            current.map((image, i) =>
              i === index ? { ...image, src: "", loading: false } : image,
            ),
          );
        },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [createAssetUrl, cwd, httpBaseUrl, paths, resolvedPaths, searchEntries, threadRef]);

  return (
    <ImageLightbox
      actions={publishActions}
      images={images}
      initialIndex={initialIndex}
      onClose={onClose}
    />
  );
}
