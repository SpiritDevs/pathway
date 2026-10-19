import type { OrchestrationV2TurnItem } from "@spiritdevs/contracts";

const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

type WorkspacePreparationItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;

/** Recognizes server-owned setup milestones, including history from older servers. */
export function turnItemIsWorkspacePreparation(
  item: OrchestrationV2TurnItem,
): item is WorkspacePreparationItem {
  return item.type === "command_execution" && item.input === WORKSPACE_PREPARATION_INPUT;
}

export function workspacePreparationPresentation(item: WorkspacePreparationItem) {
  const preparation = item.workspacePreparation;
  const phase =
    preparation?.phase ??
    (item.title === "Preparing worktree"
      ? "worktree"
      : item.title === "Starting setup script"
        ? "setup"
        : "preparing");
  const completed = item.status === "completed";
  const failed = item.status === "failed";
  const stopped = item.status === "cancelled" || item.status === "interrupted";
  const isWorktree = preparation?.workspaceKind === "worktree";
  const currentStep = phase === "setup" ? 2 : phase === "worktree" ? 1 : 0;
  const labels = [
    "Preparing workspace",
    ...(isWorktree || phase === "worktree" ? ["Checking out files"] : []),
    "Starting setup script",
  ];
  const steps = labels.map((label) => {
    const index = label === "Starting setup script" ? 2 : label === "Checking out files" ? 1 : 0;
    const status =
      completed || index < currentStep
        ? "completed"
        : index > currentStep
          ? "pending"
          : failed
            ? "failed"
            : stopped
              ? "stopped"
              : "running";
    return {
      label:
        completed && index === 2
          ? preparation === undefined
            ? "Workspace setup"
            : !preparation.terminalId
              ? "No setup script configured"
              : label
          : label,
      status,
    } as const;
  });
  return {
    title: failed
      ? "Workspace setup failed"
      : stopped
        ? "Workspace setup stopped"
        : completed
          ? isWorktree
            ? "Worktree created"
            : "Workspace ready"
          : isWorktree
            ? "Creating a worktree"
            : "Preparing workspace",
    steps,
    completed,
    failed,
    stopped,
  };
}
