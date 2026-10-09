import { MoreHorizontal } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";

import { PreviewFavicon } from "./PreviewFavicon";

interface Props {
  url: string;
  title?: string | undefined;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  /** Omitted for pages that aren't in history, such as pins. */
  onRemove?: (() => void) | undefined;
}

/** A pinned or recently visited page on the new-tab page. */
export function PreviewSiteTile({ url, title, pinned, onOpen, onTogglePin, onRemove }: Props) {
  const parsed = new URL(url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const label = `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  return (
    <div className="group relative">
      <button
        type="button"
        title={title ? `${title}\n${label}` : label}
        onClick={onOpen}
        className="flex w-full cursor-pointer flex-col items-center gap-3 rounded-xl px-3 pt-5 pb-4 text-center hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PreviewFavicon url={url} size={64} className="size-8 text-muted-foreground" />
        <span className="w-full truncate text-sm text-foreground">{title ?? label}</span>
      </button>
      <Menu>
        <MenuTrigger
          aria-label={`More actions for ${title ?? label}`}
          className="absolute top-1 right-1 flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 data-popup-open:opacity-100"
        >
          <MoreHorizontal className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-40">
          <MenuItem onClick={onTogglePin}>{pinned ? "Unpin" : "Pin"}</MenuItem>
          {onRemove ? <MenuItem onClick={onRemove}>Remove from history</MenuItem> : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}
