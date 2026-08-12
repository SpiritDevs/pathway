import { GitBranchIcon, Link2Icon, ListTodoIcon } from "lucide-react";
import type { ReactNode } from "react";

function ActionRow({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="group/action flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-start text-[13px] text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      onClick={onClick}
      type="button"
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground group-hover/action:text-foreground">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

export function IssueActionPanel({
  onAddTodo,
  onAddSubIssue,
  onAddRelation,
}: {
  onAddTodo: () => void;
  onAddSubIssue: () => void;
  onAddRelation: () => void;
}) {
  return (
    <section className="flex flex-col gap-1 border-t border-border/50 pt-3">
      <h3 className="px-1.5 text-xs font-medium text-muted-foreground">Actions</h3>
      <div className="flex flex-col">
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
