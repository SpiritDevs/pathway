import type { ProviderApprovalDecision } from "@spiritdevs/contracts";
import {
  parseComputerApprovalPrompt,
  type ComputerApprovalPrompt,
} from "@spiritdevs/client-runtime/state/computer-approval";

import {
  COMPUTER_TOOL_TITLES,
  computerToolName,
  describeComputerToolCall,
  type ComputerToolCallDescription,
} from "~/lib/computerToolPresentation";
import type { PendingApproval } from "../../session-logic";

export interface ApprovalAction {
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
  readonly description: string;
}

/** Card-local shortcut order (1-4): recommended action first, stop-everything last. */
export const APPROVAL_ACTIONS: ReadonlyArray<ApprovalAction> = [
  { decision: "accept", label: "Approve once", description: "Allow just this request" },
  {
    decision: "acceptForSession",
    label: "Always allow this session",
    description: "Don't ask again this session",
  },
  { decision: "decline", label: "Decline", description: "Reject and let the agent continue" },
  { decision: "cancel", label: "Cancel turn", description: "Stop the current turn" },
];

export const COMPUTER_TASK_ACCEPT_DESCRIPTION =
  "Continue routine desktop actions until this response ends. Stop cancels access. Clipboard reads still ask separately.";

/**
 * The actions a card offers, in shortcut order. Computer cards never offer the
 * session-wide approval: the server answers it with a decline, so the button
 * would lie. Task consent relabels the rest the way Synara does.
 */
export function resolveApprovalActions(
  computer: ComputerApprovalPrompt | null,
): ReadonlyArray<ApprovalAction> {
  if (computer === null) return APPROVAL_ACTIONS;
  const actions = APPROVAL_ACTIONS.filter((action) => action.decision !== "acceptForSession");
  if (computer.scope === "call") return actions;
  return actions.map((action) =>
    action.decision === "accept"
      ? computer.scope === "task"
        ? {
            ...action,
            label: "Allow Computer for this task",
            description: COMPUTER_TASK_ACCEPT_DESCRIPTION,
          }
        : {
            ...action,
            label: `Allow ${computer.app} for this task`,
            description: `Let Computer use ${computer.app} until this response ends.`,
          }
      : action.decision === "decline"
        ? { ...action, description: "Stop desktop for this turn, agent continues without tools" }
        : {
            ...action,
            description: "Stop revokes new input; keys/buttons already sent may still land.",
          },
  );
}

export type PendingApprovalPresentation =
  | { readonly kind: "generic"; readonly summary: string; readonly detailLabel: string }
  | {
      readonly kind: "computer";
      readonly summary: string;
      readonly description: string | null;
      readonly toolName: string | null;
      readonly call: ComputerToolCallDescription | null;
    };

/** What the approval card says, by request kind and Computer scope. */
export function describePendingApproval(approval: PendingApproval): PendingApprovalPresentation {
  switch (approval.requestKind) {
    case "command":
      return { kind: "generic", summary: "Command approval requested", detailLabel: "Command" };
    case "file-read":
      return {
        kind: "generic",
        summary: "File-read approval requested",
        detailLabel: "File to read",
      };
    case "file-change":
      return {
        kind: "generic",
        summary: "File-change approval requested",
        detailLabel: "File change",
      };
    case "computer":
      break;
  }
  const computer = parseComputerApprovalPrompt(approval);
  if (computer?.scope === "task") {
    return {
      kind: "computer",
      summary: "Allow Computer for this task?",
      description: COMPUTER_TASK_ACCEPT_DESCRIPTION,
      toolName: null,
      call: null,
    };
  }
  if (computer?.scope === "app") {
    return {
      kind: "computer",
      summary: `Allow Computer to use ${computer.app} in this task?`,
      description: null,
      toolName: null,
      call: null,
    };
  }
  if (computer?.scope === "call") {
    const tool = computerToolName(computer.toolName);
    return {
      kind: "computer",
      summary: "Approve this tool call?",
      description: null,
      toolName: tool === null ? computer.toolName : COMPUTER_TOOL_TITLES[tool],
      call: describeComputerToolCall({ toolName: computer.toolName, args: computer.args }),
    };
  }
  return {
    kind: "computer",
    summary: "Computer approval requested",
    description: approval.detail ?? null,
    toolName: null,
    call: null,
  };
}

/**
 * The action a bare digit picks, or null. Digits only count when they come
 * from inside the card and not from a text field, so a number typed anywhere
 * else can never approve a request.
 */
export function approvalShortcutAction(
  event: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly targetIsEditable: boolean;
  },
  actions: ReadonlyArray<ApprovalAction>,
): ApprovalAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.targetIsEditable) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  return actions[Number(event.key) - 1] ?? null;
}

/** Whether a respond command was sent: an atom `Success`. A local guard that sent nothing resolves empty. */
export function approvalResponseSent(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    "_tag" in result &&
    (result as { readonly _tag: unknown })._tag === "Success"
  );
}

/**
 * One response attempt of a request: its id plus the live provider session the
 * answer goes to, so a request re-posted to a new session can be answered again.
 */
export function approvalSubmissionKey(approval: {
  readonly requestId: string;
  readonly responseAttemptKey?: string;
}): string {
  return JSON.stringify([approval.requestId, approval.responseAttemptKey ?? null]);
}

/**
 * Sends one decision per response attempt. Clicks and shortcuts share the
 * claim; only a sent response keeps it, until a new attempt key arrives. A
 * failed send, or one a local guard refused, releases it so the user can
 * retry or cancel. Returns null when suppressed, else a promise that settles
 * once the claim is kept or released.
 */
export function respondToApprovalOnce(input: {
  readonly claim: { current: string | null };
  readonly requestKey: string;
  readonly isResponding: boolean;
  readonly respond: () => Promise<unknown>;
}): Promise<void> | null {
  const { claim, requestKey } = input;
  if (input.isResponding || claim.current === requestKey) return null;
  claim.current = requestKey;
  const release = () => {
    if (claim.current === requestKey) claim.current = null;
  };
  return input.respond().then((result) => {
    if (!approvalResponseSent(result)) release();
  }, release);
}
