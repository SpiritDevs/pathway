import { useEffect, useRef } from "react";
import { useLocation } from "@tanstack/react-router";
import { isInAlertQuietHours } from "@spiritdevs/client-runtime/thread-alerts";
import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
import { showThreadAlert } from "../../threadAlerts/delivery";
import { previewAlertSound } from "../../threadAlerts/audio";
import { useOrchestrators } from "./OrchestratorContext";
import { claimOrchestratorNotification, shouldNotifyOrchestrator } from "./notificationDelivery";

/** Shares device delivery choices; messages and unread state remain cloud-owned. */
export function OrchestratorNotificationHost() {
  const state = useOrchestrators();
  const settings = useClientSettings((value) => value.threadAlerts);
  const ready = useClientSettingsHydrated();
  const pathname = useLocation({ select: (location) => location.pathname });
  const latest = useRef({ state, settings, ready, pathname });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  latest.current = { state, settings, ready, pathname };
  const account = useRef({ id: state.accountID, startedAt: Date.now() });
  if (account.current.id !== state.accountID)
    account.current = { id: state.accountID, startedAt: Date.now() };
  useEffect(() => {
    const userId = state.accountID;
    if (!userId || !ready) return;
    for (const chat of state.chats) {
      if (!chat.notification) continue;
      void claimOrchestratorNotification(userId, chat, (seenSequence) => {
        const current = latest.current;
        if (!mounted.current || current.state.accountID !== userId || !current.ready) return null;
        const currentChat = current.state.chats.find((item) => item.id === chat.id);
        if (!currentChat) return false;
        return shouldNotifyOrchestrator({
          chat: currentChat,
          seenSequence,
          startedAt: account.current.startedAt,
          focusedChatId:
            document.hasFocus() &&
            document.visibilityState === "visible" &&
            (current.state.floating || current.pathname === "/orchestrator")
              ? current.state.selectedId
              : null,
          quiet: isInAlertQuietHours(current.settings.quietHours, new Date()),
        });
      }).then(async (claimed) => {
        const current = latest.current;
        const isActive = () =>
          mounted.current &&
          latest.current.state.accountID === userId &&
          latest.current.state.chats.some(
            (item) =>
              item.id === chat.id &&
              !item.archived &&
              item.readSequence < chat.notification!.sequence,
          );
        if (!claimed || !isActive()) return;
        await Promise.allSettled([
          current.settings.osNotificationsEnabled
            ? showThreadAlert(
                {
                  userId,
                  id: `orchestrator:${chat.id}:${chat.notification!.sequence}`,
                  title: chat.notification!.senderName,
                  body: chat.notification!.text,
                  target: { kind: "orchestrator", chatId: chat.id },
                },
                () => {
                  const current = latest.current.state;
                  if (
                    current.accountID === userId &&
                    current.chats.some((item) => item.id === chat.id)
                  ) {
                    current.selectChat(chat.id);
                    current.setFloating(true);
                  }
                },
                isActive,
              )
            : Promise.resolve(),
          current.settings.soundEnabled ? previewAlertSound(current.settings) : Promise.resolve(),
        ]);
      });
    }
  }, [state.accountID, state.chats, ready]);
  return null;
}
