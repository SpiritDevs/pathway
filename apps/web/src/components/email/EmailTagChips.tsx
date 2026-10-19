import type { EmailTag, EmailTagId } from "@spiritdevs/contracts";

const EMPTY_TAG_IDS: ReadonlyArray<EmailTagId> = Object.freeze([]);

export function EmailTagChips({
  tagIds = EMPTY_TAG_IDS,
  tags,
  limit,
}: {
  tagIds?: ReadonlyArray<EmailTagId>;
  tags: ReadonlyArray<EmailTag>;
  limit?: number;
}) {
  const resolved = tagIds.flatMap((id) => {
    const tag = tags.find((candidate) => candidate.id === id);
    return tag === undefined ? [] : [tag];
  });
  const visible = limit === undefined ? resolved : resolved.slice(0, limit);
  if (visible.length === 0) return null;
  return (
    <span
      className={
        limit === undefined
          ? "flex min-w-0 flex-wrap items-center gap-1"
          : "flex min-w-0 shrink-0 items-center gap-1"
      }
    >
      {visible.map((tag) => (
        <span
          className="inline-flex max-w-28 items-center gap-1 rounded-full border border-border/60 bg-background/60 px-1.5 py-px text-[10px] font-medium text-muted-foreground"
          key={tag.id}
          title={tag.name}
        >
          <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
          <span className="truncate">{tag.name}</span>
        </span>
      ))}
      {limit !== undefined && resolved.length > limit ? (
        <span className="text-[10px] text-muted-foreground">+{resolved.length - limit}</span>
      ) : null}
    </span>
  );
}
