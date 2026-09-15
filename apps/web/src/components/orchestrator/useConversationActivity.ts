import { useEffect, useState } from "react";
import type { OrchestratorActivity } from "@spiritdevs/contracts/aiOrchestrator";
import { activeConversationIds } from "./conversationActivity";

export function useConversationActivity(activity: OrchestratorActivity) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const current = Date.now();
    const nextExpiry = Math.min(
      ...activity.map((item) => item.expiresAt).filter((time) => time > current),
    );
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - current));
    return () => clearTimeout(timer);
  }, [activity, now]);
  return activeConversationIds(activity, Math.max(now, Date.now()));
}
