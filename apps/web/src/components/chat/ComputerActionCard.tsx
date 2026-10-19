import { MonitorIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/**
 * Shared transcript card shell for Computer control notices (setup required,
 * control denied): status tile, title, description, and one action button.
 */
export function ComputerActionCard({
  tone,
  title,
  action,
  children,
}: {
  readonly tone: "warning" | "success" | "error";
  readonly title: string;
  readonly action?:
    | { readonly label: string; readonly disabled?: boolean; readonly onClick: () => void }
    | undefined;
  /** Description paragraphs; each inherits the card's secondary text style. */
  readonly children?: ReactNode;
}) {
  return (
    <div className="my-1 flex items-start gap-3 rounded-xl border border-border/65 bg-card p-3 text-sm">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          tone === "success"
            ? "bg-success/8 text-success dark:bg-success/16"
            : tone === "error"
              ? "bg-destructive/8 text-destructive dark:bg-destructive/16"
              : "bg-warning/8 text-warning dark:bg-warning/16",
        )}
      >
        <MonitorIcon className="size-4.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium text-foreground">{title}</p>
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {children}
        </div>
      </div>
      {action ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 self-center"
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
