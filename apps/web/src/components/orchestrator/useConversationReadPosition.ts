import { useEffect, useRef, type RefObject } from "react";
import { makeFunctionReference } from "convex/server";
import { useOrchestrators } from "./OrchestratorContext";

/** Only advance the receipt for messages actually visible in the focused conversation. */
export function useConversationReadPosition(
  container: RefObject<HTMLDivElement | null>,
  chatId: string,
  readSequence: number,
  messageIds: string,
  searching: boolean,
) {
  const state = useOrchestrators();
  const confirmed = useRef(readSequence);
  confirmed.current = Math.max(confirmed.current, readSequence);
  useEffect(() => {
    const element = container.current;
    const client = state.client;
    if (!element || !client || searching) return;
    const visible = new Map<Element, number>();
    let disposed = false;
    let inFlight = false;
    const markRead = async () => {
      if (disposed || inFlight || document.visibilityState !== "visible" || !document.hasFocus())
        return;
      const sequence = Math.max(0, ...visible.values());
      if (sequence <= confirmed.current) return;
      inFlight = true;
      try {
        await client.mutation(makeFunctionReference<"mutation">("aiOrchestrators:markRead"), {
          chatId,
          sequence,
        });
        confirmed.current = Math.max(confirmed.current, sequence);
      } catch (cause) {
        if (!disposed) state.setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
      }
      if (!disposed && Math.max(0, ...visible.values()) > sequence) void markRead();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const sequence = Number((entry.target as HTMLElement).dataset.messageSequence);
          if (entry.isIntersecting && entry.intersectionRect.height > 0)
            visible.set(entry.target, sequence);
          else visible.delete(entry.target);
        }
        void markRead();
      },
      { root: element, threshold: 0 },
    );
    for (const message of element.querySelectorAll("[data-message-sequence]"))
      observer.observe(message);
    const onFocus = () => {
      void markRead();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [chatId, container, messageIds, searching, state.client, state.accountID]);
}
