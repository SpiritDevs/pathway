import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { describePendingApproval } from "./ComposerPendingApproval.logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const presentation = describePendingApproval(approval);

  return (
    <div className="min-w-0 px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{presentation.summary}</span>
        {presentation.kind === "computer" && presentation.toolName ? (
          <span className="text-xs text-muted-foreground">{presentation.toolName}</span>
        ) : null}
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.responseCapability === "not_resumable" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This request belonged to a provider process that is no longer available. Interrupt or
          restart the run to continue.
        </p>
      ) : null}
      {presentation.kind === "generic" && approval.detail ? (
        <div className="mt-3 min-w-0 max-w-full rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">{presentation.detailLabel}</p>
          <pre
            aria-label={presentation.detailLabel}
            className="mt-2 min-w-0 max-w-full max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-relaxed text-foreground"
            data-approval-detail="complete"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
      {presentation.kind === "computer" && presentation.description ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {presentation.description}
        </p>
      ) : null}
      {presentation.kind === "computer" && presentation.call ? (
        <div className="mt-3 min-w-0 max-w-full rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-sm leading-snug text-foreground [overflow-wrap:anywhere]">
            {presentation.call.summary}
          </p>
          {presentation.call.params.length > 0 ? (
            <dl
              aria-label="Computer action details"
              className="mt-2 max-h-40 space-y-1 overflow-auto text-xs leading-snug"
            >
              {presentation.call.params.map((parameter) => (
                <div className="grid grid-cols-[auto_1fr] gap-x-2" key={parameter.name}>
                  <dt className="font-medium text-muted-foreground">{parameter.name}</dt>
                  <dd className="min-w-0 font-mono text-foreground/85 [overflow-wrap:anywhere]">
                    {parameter.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
