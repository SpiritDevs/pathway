import { Globe2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import { faviconUrlForOrigin } from "~/lib/favicon";
import { cn } from "~/lib/utils";

/** A site's favicon, falling back to a globe (or `fallback`) when it has none. */
export function PreviewFavicon({
  url,
  className = "size-3",
  fallback,
  size = 32,
}: {
  url: string | null;
  className?: string;
  fallback?: ReactNode;
  /** Pixel size to fetch; ask for twice the rendered size so large icons stay sharp. */
  size?: number;
}) {
  const faviconUrl = faviconUrlForOrigin(url, size);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!faviconUrl || failedUrl === faviconUrl) {
    return fallback !== undefined ? fallback : <Globe2 className={cn("shrink-0", className)} />;
  }
  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden
      draggable={false}
      className={cn("shrink-0 rounded-sm", className)}
      onError={() => setFailedUrl(faviconUrl)}
    />
  );
}
