import { CircleDotIcon, XIcon } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { IssueContextSelection } from "~/lib/issueContext";
import { cn } from "~/lib/utils";

export function ComposerPendingIssueContextChip({
  context,
  onRemove,
}: {
  readonly context: IssueContextSelection;
  readonly onRemove: (contextId: string) => void;
}) {
  const label = `${context.key} ${context.title}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "max-w-72 pr-1")}>
            <CircleDotIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} aria-hidden />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
            <button
              type="button"
              aria-label={`Remove ${context.key} from this discussion`}
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(context.id);
              }}
            >
              <XIcon className="size-3" aria-hidden />
            </button>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-normal leading-tight">
        {context.key} — {context.title}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerPendingIssueContexts({
  contexts,
  onRemove,
  className,
}: {
  readonly contexts: ReadonlyArray<IssueContextSelection>;
  readonly onRemove: (contextId: string) => void;
  readonly className?: string;
}) {
  if (contexts.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} aria-label="Issues in this discussion">
      {contexts.map((context) => (
        <ComposerPendingIssueContextChip key={context.id} context={context} onRemove={onRemove} />
      ))}
    </div>
  );
}
