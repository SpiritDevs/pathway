import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeRequestId } from "@spiritdevs/contracts";
import { toastManager } from "../ui/toast";

/** Keeps provider delivery behind Undo, and cancels unsent dismissals on navigation. */
export function useQuestionDismissal(
  onDismiss: (requestId: RuntimeRequestId) => Promise<void>,
  enabled: boolean,
) {
  const pending = useRef(
    new Map<
      RuntimeRequestId,
      { timer: ReturnType<typeof setTimeout>; toastId: ReturnType<typeof toastManager.add> }
    >(),
  );
  const [queuedRequestIds, setQueuedRequestIds] = useState<RuntimeRequestId[]>([]);
  useEffect(() => {
    const requests = pending.current;
    setQueuedRequestIds([]);
    return () => {
      for (const entry of requests.values()) {
        clearTimeout(entry.timer);
        toastManager.close(entry.toastId);
      }
      requests.clear();
    };
  }, [onDismiss, enabled]);

  const scheduleDismissal = useCallback(
    (requestId: RuntimeRequestId) => {
      if (!enabled || pending.current.has(requestId)) return;
      const undo = () => {
        const entry = pending.current.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.current.delete(requestId);
        toastManager.close(entry.toastId);
        setQueuedRequestIds((ids) => ids.filter((id) => id !== requestId));
      };
      const toastId = toastManager.add({
        title: "Ignoring question in 5 seconds",
        description: "Undo to keep the question open.",
        timeout: 0,
        actionProps: { children: "Undo", onClick: undo },
        data: { onClose: undo },
      });
      const timer = setTimeout(() => {
        pending.current.delete(requestId);
        toastManager.close(toastId);
        setQueuedRequestIds((ids) => ids.filter((id) => id !== requestId));
        void onDismiss(requestId);
      }, 5_000);
      pending.current.set(requestId, { timer, toastId });
      setQueuedRequestIds((ids) => [...ids, requestId]);
    },
    [enabled, onDismiss],
  );
  return { scheduleDismissal, queuedRequestIds };
}
