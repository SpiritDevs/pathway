import { X } from "lucide-react";

import type { BrowserHistoryEntry } from "~/browserHistoryStore";

import { PreviewFavicon } from "./PreviewFavicon";

interface Props {
  entry: BrowserHistoryEntry;
  onOpen: () => void;
  onRemove: () => void;
}

/** A frequently visited page on the new-tab page. */
export function PreviewSiteTile({ entry, onOpen, onRemove }: Props) {
  const parsed = new URL(entry.url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const label = `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  return (
    <div className="group relative">
      <button
        type="button"
        title={entry.title ? `${entry.title}\n${label}` : label}
        onClick={onOpen}
        className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-xl px-2 py-3 text-center hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background">
          <PreviewFavicon url={entry.url} className="size-5 text-muted-foreground" />
        </span>
        <span className="w-full truncate text-xs text-foreground">{entry.title ?? label}</span>
      </button>
      <button
        type="button"
        aria-label={`Remove ${label} from history`}
        onClick={onRemove}
        className="absolute top-1 right-1 rounded-full p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
