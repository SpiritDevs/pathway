/** How long after an agent's last action a tab's page loads count as the agent's. */
const AGENT_ACTIVITY_WINDOW_MS = 10_000;

const lastAgentActionAt = new Map<string, number>();

/** Notes that an agent acted in a desktop tab, keyed by runtime tab id. */
export function markBrowserAgentActivity(runtimeTabId: string, at = Date.now()): void {
  lastAgentActionAt.set(runtimeTabId, at);
}

/** Whether an agent acted in this tab recently enough to own its next page load. */
export function isBrowserAgentActive(runtimeTabId: string, at = Date.now()): boolean {
  const last = lastAgentActionAt.get(runtimeTabId);
  if (last === undefined) return false;
  if (at - last <= AGENT_ACTIVITY_WINDOW_MS) return true;
  lastAgentActionAt.delete(runtimeTabId);
  return false;
}
