import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS, type OrchestrationV2Command } from "@spiritdevs/contracts";

/** Shared sessions expose the conversation protocol, never environment-wide tools. */
export function isConversationRpcAllowed(method: string): boolean {
  return new Set<string>([
    ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
    ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
    ORCHESTRATION_V2_WS_METHODS.searchThreads,
    ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
    ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
    ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
    ORCHESTRATION_V2_WS_METHODS.subscribeShell,
    ORCHESTRATION_V2_WS_METHODS.subscribeThread,
    WS_METHODS.serverProbe,
    WS_METHODS.serverGetConfig,
    WS_METHODS.subscribeServerConfig,
  ]).has(method);
}

/** Lifecycle and workspace changes stay with the owner; collaboration can drive turns. */
export function conversationCommandAction(command: OrchestrationV2Command): "read" | "collaborate" | "manage" {
  switch (command.type) {
    case "thread.visit":
      return "read";
    case "message.dispatch":
    case "message.edit-and-restart":
    case "run.interrupt":
    case "queued-message.promote-to-steer":
    case "queued-run.reorder":
    case "queued-run.cancel":
    case "queued-run.edit":
    case "runtime-request.respond":
    case "thread.model-selection.set":
    case "thread.interaction-mode.set":
      return "collaborate";
    default:
      return "manage";
  }
}
