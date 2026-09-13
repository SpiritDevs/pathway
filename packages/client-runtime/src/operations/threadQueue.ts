import {
  CommandId,
  type ChatAttachment,
  type OrchestrationV2ThreadShell,
  type RunId,
} from "@spiritdevs/contracts";
import type { ThreadQueueSubmission } from "@spiritdevs/contracts/threadQueue";
import type { StartThreadTurnInput } from "./commands.ts";

/** Pure cloud submission construction; callers persist the result before any network work. */
export function buildThreadQueueSubmission(
  input: StartThreadTurnInput,
  attachments: ReadonlyArray<ChatAttachment>,
  existingThread?: Pick<
    OrchestrationV2ThreadShell,
    "projectId" | "temporary" | "conversationCompanyId" | "title" | "modelSelection"
  > | null,
  activeRunId?: RunId | null,
): ThreadQueueSubmission {
  const commandId = input.commandId ?? CommandId.make(`queue-${input.message.messageId}`);
  const bootstrap = input.bootstrap?.createThread;
  const prepare = input.bootstrap?.prepareWorktree;
  if (bootstrap || prepare) {
    const thread = bootstrap ?? existingThread;
    if (!thread) throw new Error("Thread details are needed before preparing a workspace.");
    return {
      kind: "launch",
      input: {
        commandId,
        creationSource: input.creationSource ?? "web",
        threadId: input.threadId,
        ...(bootstrap ? {} : { reuseExistingThread: true }),
        projectId:
          thread.conversationCompanyId &&
          thread.projectId === `conversations:${thread.conversationCompanyId}`
            ? null
            : thread.projectId,
        ...(thread.temporary === undefined ? {} : { temporary: thread.temporary }),
        ...(thread.conversationCompanyId === undefined
          ? {}
          : { conversationCompanyId: thread.conversationCompanyId }),
        title: input.titleSeed ?? thread.title,
        generateTitle: input.titleSeed !== undefined,
        modelSelection: input.modelSelection ?? thread.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        ...(bootstrap?.locations ? { locations: bootstrap.locations } : {}),
        workspaceStrategy: prepare
          ? {
              type: "worktree",
              baseRef: prepare.baseBranch,
              ...(prepare.branch ? { branch: prepare.branch } : {}),
              ...(prepare.startFromOrigin ? { startFromOrigin: true } : {}),
            }
          : bootstrap?.worktreePath
            ? {
                type: "existing_worktree",
                worktreePath: bootstrap.worktreePath,
                ...(bootstrap.branch ? { branch: bootstrap.branch } : {}),
              }
            : { type: "root", ...(bootstrap?.branch ? { branch: bootstrap.branch } : {}) },
        initialMessage: {
          messageId: input.message.messageId,
          text: input.message.text,
          attachments,
        },
      },
    };
  }
  if ((input.dispatchMode === "steer" || input.dispatchMode === "restart") && !activeRunId)
    throw new Error(
      "The active turn is no longer available. Send this message as a queued turn instead.",
    );
  return {
    kind: "message",
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    input: {
      type: "message.dispatch",
      commandId,
      threadId: input.threadId,
      createdBy: "user",
      creationSource: input.creationSource ?? "web",
      messageId: input.message.messageId,
      text: input.message.text,
      attachments,
      dispatchMode:
        input.dispatchMode === "steer" && activeRunId
          ? { type: "steer_active", targetRunId: activeRunId }
          : input.dispatchMode === "restart" && activeRunId
            ? { type: "restart_active", targetRunId: activeRunId }
            : { type: "queue_after_active" },
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.titleSeed ? { titleSeed: input.titleSeed } : {}),
      ...(input.sourceProposedPlan ? { sourcePlanRef: input.sourceProposedPlan } : {}),
    },
  };
}
