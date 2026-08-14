/**
 * The row vocabulary: priority, status, label, and assignee glyphs.
 *
 * All four are drawn rather than pulled from `lucide` because they carry data — a status wears its
 * configured colour and its category's shape, and a priority is a bar chart, not a word.
 *
 * @module components/issues/IssueGlyphs
 */
import type {
  IssueAssignee,
  IssuePriority,
  IssueStatus,
  IssueStatusCategory,
} from "@spiritdevs/contracts";
import { UserIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { PROVIDER_CLIENT_DEFINITION_BY_VALUE } from "../settings/providerDriverMeta";
import { ISSUE_PRIORITY_LABELS } from "./issuesList.logic";

export function IssuePriorityIcon({
  priority,
  className,
}: {
  priority: IssuePriority;
  className?: string;
}) {
  const label = ISSUE_PRIORITY_LABELS[priority];
  if (priority === "urgent") {
    return (
      <svg
        aria-label={label}
        className={cn("size-3.5 text-orange-500", className)}
        fill="none"
        role="img"
        viewBox="0 0 16 16"
      >
        <rect fill="currentColor" height="14" rx="3" width="14" x="1" y="1" />
        <path
          d="M8 4.25v4.5"
          stroke="var(--color-background, #fff)"
          strokeLinecap="round"
          strokeWidth="1.75"
        />
        <circle cx="8" cy="11.5" fill="var(--color-background, #fff)" r="1" />
      </svg>
    );
  }

  // Three bars, filled from the left; "none" greys all three and shortens them into dashes so an
  // unset priority never reads as "low".
  const filled = priority === "high" ? 3 : priority === "medium" ? 2 : priority === "low" ? 1 : 0;
  if (priority === "none") {
    return (
      <svg
        aria-label={label}
        className={cn("size-3.5 text-muted-foreground/50", className)}
        fill="none"
        role="img"
        viewBox="0 0 16 16"
      >
        {[1, 6, 11].map((x) => (
          <rect fill="currentColor" height="1.75" key={x} rx="0.875" width="4" x={x} y="7" />
        ))}
      </svg>
    );
  }

  return (
    <svg
      aria-label={label}
      className={cn("size-3.5 text-foreground/80", className)}
      fill="none"
      role="img"
      viewBox="0 0 16 16"
    >
      {[
        { x: 1, y: 9, height: 5 },
        { x: 6, y: 6, height: 8 },
        { x: 11, y: 3, height: 11 },
      ].map((bar, index) => (
        <rect
          className={index < filled ? undefined : "opacity-25"}
          fill="currentColor"
          height={bar.height}
          key={bar.x}
          rx="1"
          width="4"
          x={bar.x}
          y={bar.y}
        />
      ))}
    </svg>
  );
}

/**
 * One shape per category, coloured by the status itself. Categories — not names — are what the
 * tabs and the rollups read, so they are what the eye should be able to sort by too.
 */
export function IssueStatusIcon({
  category,
  color,
  label,
  className,
}: {
  category: IssueStatusCategory;
  color: string;
  label: string;
  className?: string | undefined;
}) {
  return (
    <svg
      aria-label={label}
      className={cn("size-3.5 shrink-0", className)}
      fill="none"
      role="img"
      style={{ color }}
      viewBox="0 0 16 16"
    >
      {category === "backlog" ? (
        <circle
          cx="8"
          cy="8"
          r="6"
          stroke="currentColor"
          strokeDasharray="2.6 2.2"
          strokeWidth="1.75"
        />
      ) : category === "completed" || category === "canceled" ? (
        <circle cx="8" cy="8" fill="currentColor" r="7" />
      ) : (
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.75" />
      )}
      {category === "started" ? (
        <path d="M8 8V3.5A4.5 4.5 0 0 1 8 12.5Z" fill="currentColor" />
      ) : null}
      {category === "review" ? <circle cx="8" cy="8" fill="currentColor" r="2.25" /> : null}
      {category === "completed" ? (
        <path
          d="m4.9 8.2 2.1 2.2 4.1-4.6"
          stroke="var(--color-background, #fff)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.75"
        />
      ) : null}
      {category === "canceled" ? (
        <path
          d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8"
          stroke="var(--color-background, #fff)"
          strokeLinecap="round"
          strokeWidth="1.75"
        />
      ) : null}
    </svg>
  );
}

export function IssueStatusDot({ status, className }: { status: IssueStatus; className?: string }) {
  return (
    <IssueStatusIcon
      category={status.category}
      className={className}
      color={status.color}
      label={status.name}
    />
  );
}

const PROGRESS_RING_RADIUS = 6;
const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RING_RADIUS;

/**
 * The `3/9` ring a parent issue and a milestone both wear. Drawn rather than filled from a bar so
 * it survives at 14px in a list row, and started at twelve o'clock because a clock is what a
 * quarter-done ring is read as.
 */
export function IssueProgressRing({
  done,
  total,
  className,
}: {
  done: number;
  total: number;
  className?: string;
}) {
  const ratio = total === 0 ? 0 : Math.min(1, Math.max(0, done / total));
  const complete = total > 0 && done === total;
  return (
    <svg
      aria-hidden
      className={cn("size-3.5 shrink-0 -rotate-90 text-primary", className)}
      fill="none"
      viewBox="0 0 16 16"
    >
      <circle
        className="text-border"
        cx="8"
        cy="8"
        r={PROGRESS_RING_RADIUS}
        stroke="currentColor"
        strokeWidth="2"
      />
      {ratio === 0 ? null : (
        <circle
          cx="8"
          cy="8"
          r={PROGRESS_RING_RADIUS}
          stroke="currentColor"
          strokeDasharray={`${ratio * PROGRESS_RING_CIRCUMFERENCE} ${PROGRESS_RING_CIRCUMFERENCE}`}
          strokeLinecap={complete ? "butt" : "round"}
          strokeWidth="2"
        />
      )}
    </svg>
  );
}

export function IssueLabelDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: color }}
    />
  );
}

/** A person is a circle; an agent wears its provider's mark, which is how threads name them too. */
export function IssueAssigneeGlyph({
  assignee,
  className,
}: {
  assignee: IssueAssignee | null;
  className?: string;
}) {
  if (assignee === null) {
    return (
      <span
        aria-label="Unassigned"
        className={cn(
          "flex size-5 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground/60",
          className,
        )}
        role="img"
      >
        <UserIcon className="size-2.5" />
      </span>
    );
  }
  if (assignee.kind === "user") {
    return (
      <span
        aria-label="Assigned to you"
        className={cn(
          "flex size-5 items-center justify-center rounded-full bg-primary/16 text-primary",
          className,
        )}
        role="img"
      >
        <UserIcon className="size-2.5" />
      </span>
    );
  }
  // A teammate is a person, so the same circle as you, without the "this is mine" accent. The
  // membership rides the label because it is the only thing that tells two teammates apart until
  // the member directory lands.
  if (assignee.kind === "member") {
    return (
      <span
        aria-label={`Assigned to ${assignee.membershipId}`}
        className={cn(
          "flex size-5 items-center justify-center rounded-full bg-muted text-foreground/80",
          className,
        )}
        role="img"
      >
        <UserIcon className="size-2.5" />
      </span>
    );
  }
  const definition = PROVIDER_CLIENT_DEFINITION_BY_VALUE[assignee.provider];
  const ProviderIcon = definition?.icon;
  return (
    <span
      aria-label={`Assigned to ${definition?.label ?? assignee.provider}`}
      className={cn(
        "flex size-5 items-center justify-center rounded-full bg-muted text-foreground/80",
        className,
      )}
      role="img"
    >
      {ProviderIcon === undefined ? (
        <UserIcon className="size-2.5" />
      ) : (
        <ProviderIcon className="size-3" />
      )}
    </span>
  );
}

/**
 * Slack's pinwheel, monochrome. Drawn rather than imported for the same reason the rest of this
 * file is: it inherits `currentColor`, so one glyph reads correctly in a muted triage chip, in the
 * properties rail, and on both themes, which a brand-coloured asset would not.
 */
export function IssueSlackGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("size-3.5 shrink-0", className)}
      fill="currentColor"
      role="img"
      viewBox="0 0 16 16"
    >
      <rect height="6.6" rx="1.3" width="2.6" x="8.1" y="1.3" />
      <rect height="2.6" rx="1.3" width="6.6" x="8.1" y="8.1" />
      <rect height="6.6" rx="1.3" width="2.6" x="5.3" y="8.1" />
      <rect height="2.6" rx="1.3" width="6.6" x="1.3" y="5.3" />
    </svg>
  );
}

/**
 * A chip that says an investigation is under way. Used in the sheet header and issue list rows.
 */
export function IssueInvestigatingChip({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span
      aria-label="Investigating"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 text-primary",
        compact ? "size-3 justify-center border-0 bg-transparent" : "px-1.5 py-px text-[11px]",
        className,
      )}
      role="img"
      title="An investigation is running on this issue."
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none"
      />
      {compact ? null : "Investigating"}
    </span>
  );
}
