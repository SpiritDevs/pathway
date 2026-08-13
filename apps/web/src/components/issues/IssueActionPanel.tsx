import { GitBranchIcon, Link2Icon, ListTodoIcon, MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function ActionRow({
  icon,
  label,
  onClick,
  disabled = false,
  title,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string | undefined;
}) {
  const control = (
    <button
      className="group/action flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-start text-[13px] text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground pointer-coarse:min-h-11"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground group-hover/action:text-foreground">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );

  return title === undefined ? (
    control
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span className="block w-full cursor-not-allowed" />}>
        {control}
      </TooltipTrigger>
      <TooltipPopup side="left">{title}</TooltipPopup>
    </Tooltip>
  );
}

export function IssueActionPanel({
  onAddTodo,
  onAddSubIssue,
  onAddRelation,
  onTalkAboutIssue,
  talkAboutIssueBlockReason,
}: {
  onAddTodo: () => void;
  onAddSubIssue: () => void;
  onAddRelation: () => void;
  onTalkAboutIssue: () => void;
  talkAboutIssueBlockReason: string | null;
}) {
  return (
    <section className="flex flex-col gap-1 border-t border-border/50 pt-3">
      <h3 className="px-1.5 text-xs font-medium text-muted-foreground">Actions</h3>
      <div className="flex flex-col">
        <ActionRow
          disabled={talkAboutIssueBlockReason !== null}
          icon={<MessageSquareIcon className="size-3.5" />}
          label="Talk about issue"
          onClick={onTalkAboutIssue}
          title={talkAboutIssueBlockReason ?? undefined}
        />
        <ActionRow
          icon={<ListTodoIcon className="size-3.5" />}
          label="Add todo"
          onClick={onAddTodo}
        />
        <ActionRow
          icon={<GitBranchIcon className="size-3.5" />}
          label="Add sub-issue"
          onClick={onAddSubIssue}
        />
        <ActionRow
          icon={<Link2Icon className="size-3.5" />}
          label="Add relation"
          onClick={onAddRelation}
        />
      </div>
    </section>
  );
}
