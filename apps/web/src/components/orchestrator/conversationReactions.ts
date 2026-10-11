import {
  ORCHESTRATOR_MESSAGE_REACTIONS,
  type OrchestratorMessageReaction,
} from "@spiritdevs/contracts/aiOrchestrator";

/** Reactions as the chips under a message: one per emoji, in menu order. */
export function groupReactions(
  reactions: readonly OrchestratorMessageReaction[] | undefined,
  accountID: string,
) {
  return ORCHESTRATOR_MESSAGE_REACTIONS.flatMap((emoji) => {
    const matching = (reactions ?? []).filter((reaction) => reaction.emoji === emoji);
    return matching.length === 0
      ? []
      : [
          {
            emoji,
            count: matching.length,
            mine: matching.some((reaction) => reaction.userId === accountID),
          },
        ];
  });
}
