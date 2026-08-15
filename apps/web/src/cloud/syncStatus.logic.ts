import type {
  SyncPhase as EngineSyncPhase,
  SyncTransportError,
} from "@spiritdevs/client-runtime/sync";
import type { SyncOperationKind } from "@spiritdevs/contracts/cloudSync";

export type SyncStatusPhase =
  | "disabled"
  | "signed-out"
  | "bootstrapping"
  | "live"
  | "reconnecting"
  | "error";

export interface SyncStatusOperationKind {
  readonly kind: SyncOperationKind;
  readonly count: number;
}

export interface SyncStatusError {
  readonly classification:
    | "Offline"
    | "Connection interrupted"
    | "Sign-in required"
    | "Update required";
  readonly message: string;
}

/** The compact, render-safe health snapshot published for one company's engine. */
export interface CompanySyncStatus {
  readonly phase: SyncStatusPhase;
  readonly bootstrapComplete: boolean;
  readonly pendingCount: number;
  readonly pendingKinds: ReadonlyArray<SyncStatusOperationKind>;
  readonly blockedCount: number;
  readonly rejectedCount: number;
  readonly quarantinedCount: number;
  readonly lastError: SyncStatusError | null;
}

/** Only the engine fields that can actually support the status UI. */
export interface CompanySyncEngineState {
  readonly phase: EngineSyncPhase;
  readonly bootstrapped: boolean;
  readonly pending: ReadonlyArray<{
    readonly operation: { readonly kind: SyncOperationKind };
    readonly status: { readonly _tag: string };
  }>;
  readonly rejected: ReadonlyArray<unknown>;
  readonly quarantined: ReadonlyArray<unknown>;
  readonly lastError: Pick<SyncTransportError, "reason" | "message"> | null;
}

export function classifySyncStatusError(
  error: Pick<SyncTransportError, "reason" | "message"> | null,
): SyncStatusError | null {
  if (error === null) return null;

  let classification: SyncStatusError["classification"];
  let fallback: string;
  switch (error.reason) {
    case "offline":
      classification = "Offline";
      fallback = "The network is unavailable. Changes will sync when the connection returns.";
      break;
    case "transport":
      classification = "Connection interrupted";
      fallback = "The sync connection was interrupted. Pathway will retry automatically.";
      break;
    case "unauthorized":
      classification = "Sign-in required";
      fallback = "Pathway could not authorize cloud sync. Sign in again to continue.";
      break;
    case "upgrade-required":
      classification = "Update required";
      fallback = "This version of Pathway cannot sync with the configured deployment.";
      break;
  }

  return {
    classification,
    message: error.message.trim() || fallback,
  };
}

function derivePhase(state: Pick<CompanySyncEngineState, "phase" | "bootstrapped">) {
  if (state.phase === "failed") return "error" as const;
  if (state.phase === "disconnected") return "reconnecting" as const;
  if (state.phase === "initializing" || !state.bootstrapped) return "bootstrapping" as const;
  return "live" as const;
}

export function deriveCompanySyncStatus(state: CompanySyncEngineState): CompanySyncStatus {
  const kindCounts = new Map<SyncOperationKind, number>();
  let blockedCount = 0;
  for (const entry of state.pending) {
    kindCounts.set(entry.operation.kind, (kindCounts.get(entry.operation.kind) ?? 0) + 1);
    if (entry.status._tag === "Blocked") blockedCount += 1;
  }

  return {
    phase: derivePhase(state),
    bootstrapComplete: state.bootstrapped,
    pendingCount: state.pending.length,
    pendingKinds: [...kindCounts].map(([kind, count]) => ({ kind, count })),
    blockedCount,
    rejectedCount: state.rejected.length,
    quarantinedCount: state.quarantined.length,
    lastError: classifySyncStatusError(state.lastError),
  };
}

export function syncStatusPhaseLabel(phase: SyncStatusPhase): string {
  switch (phase) {
    case "disabled":
      return "Disabled";
    case "signed-out":
      return "Signed out";
    case "bootstrapping":
      return "Preparing local data";
    case "live":
      return "Live";
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Sync error";
  }
}
