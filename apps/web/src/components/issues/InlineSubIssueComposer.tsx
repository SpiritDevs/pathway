import type {
  Issue,
  IssueAssignee,
  IssueLabel,
  IssueLabelId,
  IssuePriority,
  IssueStatus,
  IssueStatusId,
} from "@spiritdevs/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { CircleDotIcon, TagIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useCreateIssue } from "~/state/issues";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import {
  IssueAssigneeGlyph,
  IssueLabelDot,
  IssuePriorityIcon,
  IssueStatusDot,
} from "./IssueGlyphs";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import { issueAssigneeOptionValue } from "./issueDetail.logic";
import { useIssueAssigneeOptions } from "./useIssueAssigneeOptions";
import { IssuePriorityMenu, IssueStatusMenu } from "./IssuePropertyMenus";
import { ISSUE_PRIORITY_LABELS, toggleIssueLabelIds } from "./issuesList.logic";
import { subIssueCreateInput } from "./issueSubIssues.logic";

const COMPOSER_CHIP_CLASS =
  "flex min-h-7 max-w-40 items-center gap-1.5 rounded-full border border-input bg-input/30 px-2.5 text-xs text-foreground shadow-xs/5 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring";

function DraftAssigneeMenu({
  value,
  onSelect,
}: {
  value: IssueAssignee | null;
  onSelect: (assignee: IssueAssignee | null) => void;
}) {
  const ASSIGNEE_OPTIONS = useIssueAssigneeOptions();
  const current = issueAssigneeOptionValue(value);
  const selected = ASSIGNEE_OPTIONS.find((option) => option.value === current);

  return (
    <Menu>
      <MenuTrigger
        render={
          <button className={COMPOSER_CHIP_CLASS} type="button">
            <IssueAssigneeGlyph assignee={value} className="size-3.5" label={selected?.label} />
            <span className="truncate">{selected?.label ?? "Assignee"}</span>
          </button>
        }
      />
      <MenuPopup align="start" className="min-w-52" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>Assignee</MenuGroupLabel>
          <MenuRadioGroup
            onValueChange={(next) => {
              const option = ASSIGNEE_OPTIONS.find((candidate) => candidate.value === next);
              if (option !== undefined) onSelect(option.assignee);
            }}
            value={current}
          >
            {ASSIGNEE_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                <span className="flex min-w-0 items-center gap-2">
                  <IssueAssigneeGlyph
                    assignee={option.assignee}
                    className="size-4"
                    label={option.label}
                  />
                  <span className="truncate">{option.label}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function DraftLabelsMenu({
  labels,
  value,
  onChange,
}: {
  labels: ReadonlyArray<IssueLabel>;
  value: ReadonlyArray<IssueLabelId>;
  onChange: (labelIds: ReadonlyArray<IssueLabelId>) => void;
}) {
  const selectedLabels = labels.filter((label) => value.includes(label.id));

  return (
    <Menu>
      <MenuTrigger
        render={
          <button className={COMPOSER_CHIP_CLASS} type="button">
            <TagIcon className="size-3.5 text-muted-foreground" />
            <span className="truncate">
              {selectedLabels.length === 0
                ? "Labels"
                : selectedLabels.length === 1
                  ? selectedLabels[0]?.name
                  : `${selectedLabels[0]?.name} +${selectedLabels.length - 1}`}
            </span>
          </button>
        }
      />
      <MenuPopup align="start" className="min-w-52" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>Labels</MenuGroupLabel>
          {labels.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No labels yet — add them in Settings → Labels.
            </p>
          ) : (
            labels.map((label) => (
              <MenuCheckboxItem
                checked={value.includes(label.id)}
                key={label.id}
                onCheckedChange={() => onChange(toggleIssueLabelIds(value, label.id))}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <IssueLabelDot color={label.color} />
                  <span className="truncate">{label.name}</span>
                </span>
              </MenuCheckboxItem>
            ))
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function InlineSubIssueComposer({
  open,
  parent,
  statuses,
  labels,
  onOpenChange,
}: {
  open: boolean;
  parent: Issue;
  statuses: ReadonlyArray<IssueStatus>;
  labels: ReadonlyArray<IssueLabel>;
  onOpenChange: (open: boolean) => void;
}) {
  const createIssue = useCreateIssue();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [statusId, setStatusId] = useState<IssueStatusId | null>(parent.statusId);
  const [priority, setPriority] = useState<IssuePriority>("none");
  const [assignee, setAssignee] = useState<IssueAssignee | null>(null);
  const [labelIds, setLabelIds] = useState<ReadonlyArray<IssueLabelId>>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setStatusId(
      statuses.some((status) => status.id === parent.statusId)
        ? parent.statusId
        : (statuses[0]?.id ?? null),
    );
    setPriority("none");
    setAssignee(null);
    setLabelIds([]);
    setSubmitting(false);
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, parent.statusId, statuses]);

  if (!open) return null;

  const selectedStatus = statuses.find((status) => status.id === statusId) ?? null;
  const input = subIssueCreateInput(parent, {
    title,
    description,
    statusId,
    priority,
    assignee,
    labelIds,
  });

  const submit = () => {
    if (input === null || submitting) return;
    setSubmitting(true);
    void (async () => {
      const result = await createIssue(input);
      if (reportIssueWriteFailure("Failed to create the sub-issue", result)) {
        setSubmitting(false);
        return;
      }
      if (!AsyncResult.isSuccess(result)) {
        setSubmitting(false);
        return;
      }
      onOpenChange(false);
    })();
  };

  const cancel = () => {
    if (!submitting) onOpenChange(false);
  };

  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-3 shadow-xs">
      <input
        aria-label="Sub-issue title"
        className="w-full bg-transparent text-sm font-medium leading-5 outline-none placeholder:text-placeholder"
        disabled={submitting}
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
            return;
          }
          if (event.key !== "Enter") return;
          event.preventDefault();
          submit();
        }}
        placeholder="Issue title"
        ref={titleRef}
        value={title}
      />
      <textarea
        aria-label="Sub-issue description"
        className="field-sizing-content mt-1 min-h-8 max-h-36 w-full resize-none overflow-y-auto bg-transparent text-[13px] leading-5 outline-none placeholder:text-placeholder"
        disabled={submitting}
        onChange={(event) => setDescription(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
            return;
          }
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          submit();
        }}
        placeholder="Add description…"
        rows={1}
        value={description}
      />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {statuses.length === 0 ? (
          <span className={cn(COMPOSER_CHIP_CLASS, "text-muted-foreground")}>
            <CircleDotIcon className="size-3.5" />
            Status
          </span>
        ) : (
          <IssueStatusMenu
            onSelect={setStatusId}
            statuses={statuses}
            trigger={
              <button className={COMPOSER_CHIP_CLASS} type="button">
                {selectedStatus === null ? (
                  <CircleDotIcon className="size-3.5 text-muted-foreground" />
                ) : (
                  <IssueStatusDot status={selectedStatus} />
                )}
                <span className="truncate">{selectedStatus?.name ?? "Status"}</span>
              </button>
            }
            value={statusId}
          />
        )}
        <IssuePriorityMenu
          onSelect={setPriority}
          trigger={
            <button className={COMPOSER_CHIP_CLASS} type="button">
              <IssuePriorityIcon priority={priority} />
              <span className="truncate">
                {priority === "none" ? "Priority" : ISSUE_PRIORITY_LABELS[priority]}
              </span>
            </button>
          }
          value={priority}
        />
        <DraftAssigneeMenu onSelect={setAssignee} value={assignee} />
        <DraftLabelsMenu labels={labels} onChange={setLabelIds} value={labelIds} />

        <div className="ms-auto flex items-center gap-1.5">
          <Button disabled={submitting} onClick={cancel} size="xs" variant="ghost">
            Cancel
          </Button>
          <Button disabled={input === null || submitting} onClick={submit} size="xs">
            {submitting ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}
