import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Identity of the preview automation host this client runs for an environment.
 *
 * `PreviewAutomationHosts` owns one host per connected environment and is the
 * only writer. Lifting the identity out of that component lets unrelated UI —
 * the browser takeover banner, for one — ask "is this the desktop the agent's
 * browser is pinned to?" without reaching into the host's internals.
 */
export interface PreviewAutomationHostIdentity {
  readonly clientId: string;
  /** Null until the host's request subscription reports its connection. */
  readonly connectionId: string | null;
}

interface PreviewAutomationHostStoreState {
  readonly byEnvironmentId: Record<string, PreviewAutomationHostIdentity>;
  readonly publish: (
    environmentId: EnvironmentId,
    identity: PreviewAutomationHostIdentity,
  ) => void;
  readonly clear: (environmentId: EnvironmentId) => void;
}

export const usePreviewAutomationHostStore = create<PreviewAutomationHostStoreState>()((set) => ({
  byEnvironmentId: {},
  publish: (environmentId, identity) =>
    set((state) => {
      const current = state.byEnvironmentId[environmentId];
      if (
        current &&
        current.clientId === identity.clientId &&
        current.connectionId === identity.connectionId
      ) {
        return state;
      }
      return {
        byEnvironmentId: { ...state.byEnvironmentId, [environmentId]: identity },
      };
    }),
  clear: (environmentId) =>
    set((state) => {
      if (!(environmentId in state.byEnvironmentId)) return state;
      const { [environmentId]: _removed, ...byEnvironmentId } = state.byEnvironmentId;
      return { byEnvironmentId };
    }),
}));

export function selectPreviewAutomationHostClientId(
  state: PreviewAutomationHostStoreState,
  environmentId: EnvironmentId | null,
): string | null {
  if (environmentId === null) return null;
  return state.byEnvironmentId[environmentId]?.clientId ?? null;
}

/** Imperative read for callers outside React (effects, event handlers). */
export function readPreviewAutomationHostIdentity(
  environmentId: EnvironmentId,
): PreviewAutomationHostIdentity | null {
  return usePreviewAutomationHostStore.getState().byEnvironmentId[environmentId] ?? null;
}
