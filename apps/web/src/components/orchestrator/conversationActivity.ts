import type { OrchestratorActivity } from "@spiritdevs/contracts/aiOrchestrator";

export function activeConversationIds(activity: OrchestratorActivity, now: number) {
  return new Set(activity.filter((item) => item.expiresAt > now).map((item) => item.id));
}

export function conversationAtBottom(element: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}
