import { useAtomValue } from "@effect/atom-react";
import { projectFaviconCandidatesAtom } from "../state/projectFavicons";
import { projectIconAtom, projectIconCheckoutKey } from "../state/projectIcons";
import { FocusIcon } from "./focus/FocusIcon";
import {
  isCustomProjectFaviconPath,
  projectFaviconSourceKey,
} from "../state/projectFaviconSources";
import type { EnvironmentId } from "@spiritdevs/contracts";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@spiritdevs/shared/projectFavicon";
import { FolderIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useState } from "react";
import { useAssetUrlState } from "../assets/assetUrls";
import { cn } from "~/lib/utils";

const loadedProjectFaviconSrcs = new Map<string, string>();

/**
 * A rootless project has no directory to read a favicon out of, so it renders the folder fallback
 * without asking. The split into an inner component is what keeps that a plain early return: the
 * asset hook cannot be skipped conditionally, and swapping the rendered element type remounts
 * cleanly when a directory is attached later.
 */
export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string | null;
  faviconPath?: string | null | undefined;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
}) {
  // An icon chosen for the company project wins over anything detected in the checkout.
  const syncedIcon = useAtomValue(
    projectIconAtom(input.cwd ? projectIconCheckoutKey(input.environmentId, input.cwd) : ""),
  );
  if (syncedIcon?._tag === "Library") {
    return (
      <FocusIcon
        iconName={syncedIcon.icon.name}
        color={syncedIcon.icon.color}
        className={cn("size-3.5 shrink-0", input.className)}
      />
    );
  }
  if (syncedIcon?._tag === "Image") {
    return (
      <img
        src={syncedIcon.url}
        alt=""
        className={cn("size-3.5 shrink-0 rounded-sm object-contain", input.className)}
      />
    );
  }
  if (!input.cwd) {
    return (
      <ProjectFaviconFallback className={input.className} icon={input.fallbackIcon ?? FolderIcon} />
    );
  }
  return <SharedProjectFavicon {...input} cwd={input.cwd} />;
}

function SharedProjectFavicon(input: Parameters<typeof RootedProjectFavicon>[0]) {
  const sources = useAtomValue(
    projectFaviconCandidatesAtom(projectFaviconSourceKey(input.environmentId, input.cwd)),
  );
  return (sources ?? [input]).reduceRight<ReactNode>(
    (fallback, source) => (
      <RootedProjectFavicon
        {...input}
        {...source}
        key={projectFaviconSourceKey(source.environmentId, source.cwd)}
        fallback={fallback}
      />
    ),
    null,
  );
}

export function RootedProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  faviconPath?: string | null | undefined;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
  fallback?: ReactNode;
}) {
  const state = useProjectFaviconAsset(input);
  const src = state._tag === "Success" ? state.url : null;
  const FallbackIcon = input.fallbackIcon ?? FolderIcon;

  // A checkout may have fallen back to automatic discovery because the selected file is absent.
  // Try the other connections for that file before accepting a different icon.
  if (
    input.fallback != null &&
    state._tag === "Success" &&
    state.sourcePath !== undefined &&
    isCustomProjectFaviconPath(input.faviconPath) &&
    state.sourcePath.replaceAll("\\", "/") !== input.faviconPath.replaceAll("\\", "/")
  ) {
    return input.fallback;
  }

  if (state._tag === "Failure" || isProjectFaviconFallbackUrl(src)) {
    return (
      input.fallback ?? <ProjectFaviconFallback className={input.className} icon={FallbackIcon} />
    );
  }
  if (!src) {
    return <ProjectFaviconFallback className={input.className} icon={FallbackIcon} />;
  }

  const cacheKey = getProjectFaviconCacheKey(input.environmentId, input.cwd, src);

  return (
    <ProjectFaviconImage
      key={cacheKey}
      cacheKey={cacheKey}
      src={src}
      className={input.className}
      fallbackIcon={FallbackIcon}
      fallback={input.fallback}
      refresh={state.refresh}
    />
  );
}

export function useProjectFaviconAsset(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
}) {
  return useAssetUrlState(input.environmentId, {
    _tag: "project-favicon",
    cwd: input.cwd,
    ...(input.faviconPath ? { path: input.faviconPath } : {}),
  });
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
}) {
  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", className)} />;
}

function ProjectFaviconImage({
  cacheKey,
  src,
  className,
  fallbackIcon: FallbackIcon,
  fallback,
  refresh,
}: {
  readonly cacheKey: string;
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
  readonly fallback?: ReactNode;
  readonly refresh?: (() => void) | undefined;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedProjectFaviconSrcs.get(cacheKey) ?? null,
  );
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const isLoading = displayedSrc !== src && failedSrc !== src;
  const handleLoadError = (failedUrl: string) => {
    if (loadedProjectFaviconSrcs.get(cacheKey) === failedUrl) {
      loadedProjectFaviconSrcs.delete(cacheKey);
    }
    setDisplayedSrc((currentSrc) => (currentSrc === failedUrl ? null : currentSrc));
    if (failedUrl === src) {
      setFailedSrc(failedUrl);
      refresh?.();
    }
  };

  return (
    <>
      {displayedSrc === null ? (
        failedSrc === src && fallback != null ? (
          fallback
        ) : (
          <ProjectFaviconFallback className={className} icon={FallbackIcon} />
        )
      ) : null}
      {displayedSrc ? (
        <img
          src={displayedSrc}
          alt=""
          className={cn("size-3.5 shrink-0 rounded-sm object-contain", className)}
          onError={() => handleLoadError(displayedSrc)}
        />
      ) : null}
      {isLoading ? (
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={() => {
            loadedProjectFaviconSrcs.set(cacheKey, src);
            setDisplayedSrc(src);
          }}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}
