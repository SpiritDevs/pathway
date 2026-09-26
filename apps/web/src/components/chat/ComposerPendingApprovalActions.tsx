import { type RuntimeRequestId, type ProviderApprovalDecision } from "@spiritdevs/contracts";
import { parseComputerApprovalPrompt } from "@spiritdevs/client-runtime/state/computer-approval";
import { type KeyboardEvent, memo, useRef } from "react";
import { type PendingApproval } from "../../session-logic";
import { Button } from "../ui/button";
import {
  approvalShortcutAction,
  approvalSubmissionKey,
  resolveApprovalActions,
  respondToApprovalOnce,
  type ApprovalAction,
} from "./ComposerPendingApproval.logic";

interface ComposerPendingApprovalActionsProps {
  approval: PendingApproval;
  isResponding: boolean;
  canRespond: boolean;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const BUTTON_VARIANT = {
  cancel: "ghost",
  decline: "destructive-outline",
  acceptForSession: "outline",
  accept: "default",
} as const satisfies Record<ProviderApprovalDecision, string>;

/** Left to right: stop-everything first, the recommended action last. */
const VISUAL_ORDER: ReadonlyArray<ProviderApprovalDecision> = [
  "cancel",
  "decline",
  "acceptForSession",
  "accept",
];

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  approval,
  isResponding,
  canRespond,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const claim = useRef<string | null>(null);
  const actions = resolveApprovalActions(parseComputerApprovalPrompt(approval));
  const disabled = isResponding || !canRespond;

  const respond = (action: ApprovalAction) => {
    void respondToApprovalOnce({
      claim,
      requestKey: approvalSubmissionKey(approval),
      isResponding: disabled,
      respond: () => onRespondToApproval(approval.requestId, action.decision),
    });
  };

  // Digit shortcuts bubble from focused controls inside this group only; a bare
  // number key elsewhere in the app must never approve a tool request.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    const action = approvalShortcutAction(
      {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        targetIsEditable:
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement &&
            target.closest('[contenteditable]:not([contenteditable="false"])') !== null),
      },
      actions,
    );
    if (action === null || disabled) return;
    event.preventDefault();
    respond(action);
  };

  return (
    <div className="contents" role="group" aria-label="Approval" onKeyDown={handleKeyDown}>
      {VISUAL_ORDER.map((decision) => {
        const index = actions.findIndex((action) => action.decision === decision);
        const action = actions[index];
        if (action === undefined) return null;
        const shortcut = String(index + 1);
        return (
          <Button
            key={decision}
            size="sm"
            variant={BUTTON_VARIANT[decision]}
            disabled={disabled}
            title={action.description}
            aria-keyshortcuts={shortcut}
            onClick={() => respond(action)}
          >
            {action.label}
            <kbd
              aria-hidden="true"
              className="ms-1 text-[10px] font-medium tabular-nums opacity-55"
            >
              {shortcut}
            </kbd>
          </Button>
        );
      })}
    </div>
  );
});
