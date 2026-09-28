import { BookmarkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

/**
 * Content of the stash card that sits beside the composer's front banner.
 * Shows the stash count, and the whole card is the click target for opening
 * the stash menu. The card's shape comes from the banner stack's slot.
 *
 * On save the badge gives one quiet acknowledgement: it lifts to full
 * opacity and the count ticks over. `pulseKey` changes per stash, remounting
 * the count so the transition replays without a continuous animation.
 */
export const ComposerStashBadge = memo(function ComposerStashBadge(props: {
  count: number;
  pulseKey: number;
  pulsing: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
}) {
  if (props.count === 0) return null;

  return (
    <button
      type="button"
      data-prompt-stash-badge="true"
      aria-label={`Stashed prompts: ${props.count}. Open stash.`}
      aria-expanded={props.menuOpen}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 whitespace-nowrap font-medium outline-none transition-colors duration-200",
        // Stretch the hit area over the whole card, padding included.
        "after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-ring",
        props.menuOpen || props.pulsing
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      onPointerDown={(event) => {
        // Keep composer focus so Escape/typing flows stay intact.
        event.preventDefault();
      }}
      onClick={props.onToggleMenu}
    >
      <BookmarkIcon className="size-3.5" aria-hidden="true" />
      <span className="max-sm:sr-only">Stash</span>
      <span
        key={props.pulseKey}
        className={cn(
          "rounded-full px-1.5 text-[10px] font-medium tabular-nums",
          props.pulsing
            ? "prompt-stash-count-enter bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {props.count}
      </span>
    </button>
  );
});
