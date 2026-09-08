import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@spiritdevs/contracts";
import { create } from "zustand";

const RECOVERY_STORAGE_KEY = "pathway.native-preview-popup-recovery.v1";

export interface NativePreviewPopupRecovery {
  readonly tabId: string;
  readonly threadRef: ScopedThreadRef;
  readonly serverEpoch: string | null;
  readonly runtimeTabId?: string;
  readonly logicalSessionObserved?: true;
}

const decodeRecoveries = (raw: string | null): ReadonlyArray<NativePreviewPopupRecovery> => {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.tabId !== "string" ||
        entry.tabId.length === 0 ||
        typeof entry.environmentId !== "string" ||
        entry.environmentId.length === 0 ||
        typeof entry.threadId !== "string" ||
        entry.threadId.length === 0 ||
        (entry.serverEpoch !== null && typeof entry.serverEpoch !== "string") ||
        (entry.runtimeTabId !== undefined && typeof entry.runtimeTabId !== "string") ||
        (entry.logicalSessionObserved !== undefined && entry.logicalSessionObserved !== true)
      ) {
        return [];
      }
      return [
        {
          tabId: entry.tabId,
          threadRef: {
            environmentId: EnvironmentId.make(entry.environmentId),
            threadId: ThreadId.make(entry.threadId),
          },
          serverEpoch: entry.serverEpoch,
          ...(entry.runtimeTabId === undefined ? {} : { runtimeTabId: entry.runtimeTabId }),
          ...(entry.logicalSessionObserved === true
            ? { logicalSessionObserved: true as const }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
};

const readPersistedRecoveries = (): ReadonlyArray<NativePreviewPopupRecovery> => {
  try {
    return decodeRecoveries(globalThis.sessionStorage?.getItem(RECOVERY_STORAGE_KEY) ?? null);
  } catch {
    return [];
  }
};

const recoveries = new Map(readPersistedRecoveries().map((entry) => [entry.tabId, entry]));

const persistRecoveries = (): void => {
  try {
    globalThis.sessionStorage?.setItem(
      RECOVERY_STORAGE_KEY,
      JSON.stringify(
        [...recoveries.values()].map(
          ({ tabId, threadRef, serverEpoch, runtimeTabId, logicalSessionObserved }) => ({
            tabId,
            environmentId: threadRef.environmentId,
            threadId: threadRef.threadId,
            serverEpoch,
            ...(runtimeTabId === undefined ? {} : { runtimeTabId }),
            ...(logicalSessionObserved === true ? { logicalSessionObserved: true } : {}),
          }),
        ),
      ),
    );
  } catch {
    // Recovery is best-effort when storage is unavailable; the main process still closes the guest.
  }
};

interface NativePreviewPopupState {
  readonly tabIds: ReadonlySet<string>;
  readonly recoveryRevision: number;
  readonly reserve: (tabId: string) => void;
  readonly release: (tabId: string) => void;
  readonly recoveriesChanged: () => void;
}

export const useNativePreviewPopupStore = create<NativePreviewPopupState>((set) => ({
  tabIds: new Set(recoveries.keys()),
  recoveryRevision: 0,
  reserve: (tabId) =>
    set((state) =>
      state.tabIds.has(tabId) ? state : { tabIds: new Set([...state.tabIds, tabId]) },
    ),
  release: (tabId) =>
    set((state) => {
      if (!state.tabIds.has(tabId)) return state;
      const tabIds = new Set(state.tabIds);
      tabIds.delete(tabId);
      return { tabIds };
    }),
  recoveriesChanged: () => set((state) => ({ recoveryRevision: state.recoveryRevision + 1 })),
}));

export const reserveNativePreviewPopup = (tabId: string): void =>
  useNativePreviewPopupStore.getState().reserve(tabId);

export const releaseNativePreviewPopup = (tabId: string): void =>
  useNativePreviewPopupStore.getState().release(tabId);

export const rememberNativePreviewPopup = (recovery: NativePreviewPopupRecovery): void => {
  recoveries.set(recovery.tabId, recovery);
  persistRecoveries();
  reserveNativePreviewPopup(recovery.tabId);
  useNativePreviewPopupStore.getState().recoveriesChanged();
};

export const forgetNativePreviewPopup = (tabId: string): void => {
  recoveries.delete(tabId);
  persistRecoveries();
  releaseNativePreviewPopup(tabId);
  useNativePreviewPopupStore.getState().recoveriesChanged();
};

export const markNativePreviewPopupSessionObserved = (tabId: string): void => {
  const recovery = recoveries.get(tabId);
  if (!recovery || recovery.logicalSessionObserved === true) return;
  recoveries.set(tabId, { ...recovery, logicalSessionObserved: true });
  persistRecoveries();
  useNativePreviewPopupStore.getState().recoveriesChanged();
};

export const listNativePreviewPopupRecoveries = (): ReadonlyArray<NativePreviewPopupRecovery> => [
  ...recoveries.values(),
];
