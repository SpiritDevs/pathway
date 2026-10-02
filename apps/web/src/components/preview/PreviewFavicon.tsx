import { Globe2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import { faviconUrlForOrigin } from "~/lib/favicon";
import { cn } from "~/lib/utils";

/** A site's favicon, falling back to a globe (or `fallback`) when it has none. */
export function PreviewFavicon({
  url,
  className = "size-3",
  fallback,
}: {
  url: string | null;
  className?: string;
  fallback?: ReactNode;
}) {
  const faviconUrl = faviconUrlForOrigin(url, 32);
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
