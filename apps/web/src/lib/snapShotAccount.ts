import { useSyncExternalStore } from "react";
import type { DesktopSnapShotBridge } from "./desktopSnapShot";

let currentBinding: object | null = null;
let readyAccountId: string | null = null;
let syncQueue = Promise.resolve();
const listeners = new Set<() => void>();

function publish(accountId: string | null) {
  readyAccountId = accountId;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSnapShotAccountId(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readyAccountId,
    () => null,
  );
}

/** A native capture session belongs to one authenticated account, including across async work. */
export function bindSnapShotAccount(bridge: DesktopSnapShotBridge, accountId: string | null) {
  const binding = {};
  currentBinding = binding;
  publish(null);
  const enqueue = (id: string | null) => {
    const operation = syncQueue.then(() => bridge.setSnapShotAccount(id));
    syncQueue = operation.catch(() => undefined);
    return operation;
  };
  const ready = enqueue(accountId).then(() => {
    if (currentBinding === binding) publish(accountId);
  });
  return {
    accountId,
    ready,
    isCurrent: () =>
      currentBinding === binding && accountId !== null && readyAccountId === accountId,
    release: () => {
      if (currentBinding !== binding) return Promise.resolve();
      currentBinding = null;
      publish(null);
      return enqueue(null).catch(() => undefined);
    },
  };
}
