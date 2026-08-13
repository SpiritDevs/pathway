import { cn } from "~/lib/utils";

export type IssueDetailTab = "details" | "activity" | "comments" | "investigation";

const TABS: ReadonlyArray<{ readonly id: IssueDetailTab; readonly label: string }> = [
  { id: "details", label: "Details" },
  { id: "activity", label: "Activity" },
  { id: "comments", label: "Comments" },
  { id: "investigation", label: "Investigation" },
];

export function IssueDetailTabs({
  value,
  onChange,
  activityCount,
  commentCount,
  investigationCount,
  investigating,
}: {
  value: IssueDetailTab;
  onChange: (tab: IssueDetailTab) => void;
  activityCount: number;
  commentCount: number;
  investigationCount: number;
  investigating: boolean;
}) {
  return (
    <div
      aria-label="Issue detail sections"
      className="flex border-b border-border/50"
      role="tablist"
    >
      {TABS.map((tab) => {
        const selected = value === tab.id;
        const count =
          tab.id === "activity"
            ? activityCount
            : tab.id === "comments"
              ? commentCount
              : tab.id === "investigation"
                ? investigationCount
                : 0;

        return (
          <button
            aria-controls={`issue-${tab.id}-panel`}
            aria-selected={selected}
            className={cn(
              "relative flex min-h-9 items-center gap-1.5 px-2 text-xs text-muted-foreground outline-none after:absolute after:inset-x-2 after:bottom-[-1px] after:h-px after:bg-transparent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              selected && "text-foreground after:bg-foreground",
            )}
            id={`issue-${tab.id}-tab`}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
            {tab.id === "investigation" && investigating ? (
              <span
                aria-label="Investigation running"
                className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
                role="status"
              />
            ) : count > 0 ? (
              <span className="text-[10px] tabular-nums text-muted-foreground/70">{count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
