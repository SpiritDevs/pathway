import type { ThreadAlertTarget } from "@spiritdevs/contracts/threadAlerts";

/** Keep consumed clicks across renderer listener replacements, including React's effect remount. */
export function createThreadAlertClickSubscription(input: {
  consume: () => Promise<readonly ThreadAlertTarget[]>;
  listen: (receive: () => void) => () => void;
}) {
  const listeners = new Set<(target: ThreadAlertTarget) => void>();
  const pending: ThreadAlertTarget[] = [];
  let stopListening: (() => void) | undefined;
  let consuming = false;
  let consumeAgain = false;

  const deliver = () => {
    while (listeners.size > 0 && pending.length > 0) {
      const target = pending.shift()!;
      for (const listener of listeners) listener(target);
    }
  };
  const receive = () => {
    if (consuming) {
      consumeAgain = true;
      return;
    }
    if (listeners.size === 0) return;
    consuming = true;
    void input
      .consume()
      .then((targets) => {
        pending.push(...targets);
        if (pending.length > 20) pending.splice(0, pending.length - 20);
        deliver();
      })
      .catch(() => {
        // A failed IPC request leaves clicks in the main process for the next subscription or signal.
      })
      .finally(() => {
        consuming = false;
        if (consumeAgain) {
          consumeAgain = false;
          receive();
        }
      });
  };
  return (listener: (target: ThreadAlertTarget) => void) => {
    listeners.add(listener);
    if (stopListening === undefined) stopListening = input.listen(receive);
    deliver();
    receive();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        stopListening?.();
        stopListening = undefined;
      }
    };
  };
}
