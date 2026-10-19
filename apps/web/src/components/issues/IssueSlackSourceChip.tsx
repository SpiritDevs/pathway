/**
 * Where an issue came in from, when it came in from Slack.
 *
 * One component for two surfaces — the triage row and the detail sheet's properties rail — because
 * the thing being said is the same in both: this channel, this person, and a way back to the
 * message. It is a link when Slack answered with a permalink and plain text when it did not; a
 * permalink is a nicety, not a requirement to file.
 *
 * @module components/issues/IssueSlackSourceChip
 */
import { ExternalLinkIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { IssueSlackGlyph } from "./IssueGlyphs";
import type { TriageSourceChip } from "./triage.logic";

/** Stops a press on the permalink from also selecting the row the chip is sitting in. */
function swallowRowClick(event: MouseEvent) {
  event.stopPropagation();
}

export function IssueSlackSourceChip({
  chip,
  className,
}: {
  chip: TriageSourceChip;
  className?: string;
}) {
  const body = (
    <>
      <IssueSlackGlyph className="size-3" />
      <span className="min-w-0 truncate">{chip.channelLabel}</span>
      {chip.authorLabel === null ? null : (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <span className="min-w-0 truncate">{chip.authorLabel}</span>
        </>
      )}
    </>
  );

  const shell = cn(
    "flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground",
    className,
  );

  if (chip.permalink === null) {
    return (
      <span className={shell} title={chip.label}>
        {body}
      </span>
    );
  }

  return (
    <a
      className={cn(
        shell,
        "outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
      )}
      href={chip.permalink}
      onClick={swallowRowClick}
      rel="noreferrer"
      target="_blank"
      title={`Open ${chip.label} in Slack`}
    >
      {body}
      <ExternalLinkIcon aria-hidden className="size-2.5 shrink-0 opacity-70" />
    </a>
  );
}
