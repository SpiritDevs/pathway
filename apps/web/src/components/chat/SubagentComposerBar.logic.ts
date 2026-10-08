import * as DateTime from "effect/DateTime";
import type {
  ModelSelection,
  OrchestrationV2ExecutionNode,
  OrchestrationV2RunStatus,
  ProviderDriverKind,
  ServerProviderModel,
} from "@spiritdevs/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  normalizeModelSlug,
} from "@spiritdevs/shared/model";

import { getTriggerDisplayModelName } from "./providerIconUtils";

export type SubagentBarPhase =
  | "starting"
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface SubagentBarStatus {
  readonly phase: SubagentBarPhase;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

const RUN_PHASES: Record<OrchestrationV2RunStatus, SubagentBarPhase> = {
  preparing: "starting",
  queued: "starting",
  starting: "starting",
  running: "working",
  waiting: "waiting",
  completed: "completed",
  interrupted: "interrupted",
  failed: "failed",
  cancelled: "cancelled",
  rolled_back: "cancelled",
};

const NODE_PHASES: Record<OrchestrationV2ExecutionNode["status"], SubagentBarPhase> = {
  pending: "starting",
  running: "working",
  waiting: "waiting",
  completed: "completed",
  interrupted: "interrupted",
  failed: "failed",
  cancelled: "cancelled",
  rolled_back: "cancelled",
};

const PHASE_LABELS: Record<SubagentBarPhase, string> = {
  starting: "Starting",
  working: "Working",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

/**
 * Status for the subagent bar. An app-owned subagent works in runs, and the
 * latest run wins once the user has talked to it. A provider-native subagent
 * never gets runs: its work is a runless root turn that follows the provider.
 */
export function deriveSubagentBarStatus(input: {
  readonly run: {
    readonly status: OrchestrationV2RunStatus;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
}): SubagentBarStatus | null {
  if (input.run) {
    return {
      phase: RUN_PHASES[input.run.status],
      startedAt: input.run.startedAt,
      completedAt: input.run.completedAt,
    };
  }
  const rootTurn = input.nodes.findLast((node) => node.kind === "root_turn" && node.runId === null);
  if (rootTurn === undefined) return null;
  return {
    phase: NODE_PHASES[rootTurn.status],
    startedAt: rootTurn.startedAt === null ? null : DateTime.formatIso(rootTurn.startedAt),
    completedAt: rootTurn.completedAt === null ? null : DateTime.formatIso(rootTurn.completedAt),
  };
}

function formatWholeSeconds(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  if (minutes > 0) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** "Working 12s", "Completed in 8m 1s", or the bare status when no duration is known. */
export function formatSubagentBarStatus(status: SubagentBarStatus | null, nowMs: number): string {
  if (status === null) return PHASE_LABELS.starting;
  const label = PHASE_LABELS[status.phase];
  const live = status.phase === "working";
  if (!live && status.phase !== "completed") return label;
  const start = status.startedAt === null ? Number.NaN : Date.parse(status.startedAt);
  const end = live
    ? nowMs
    : status.completedAt === null
      ? Number.NaN
      : Date.parse(status.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return label;
  const elapsed = formatWholeSeconds(end - start);
  return live ? `${label} ${elapsed}` : `${label} in ${elapsed}`;
}

// Option ids providers use for reasoning effort (Codex, Claude, Cursor, ACP, OpenCode).
const REASONING_EFFORT_OPTION_IDS = ["reasoningEffort", "effort", "reasoning", "variant"] as const;

/**
 * Model and effort labels as the composer's pickers name them. The effort is
 * null when the catalog does not describe the model rather than guessed.
 */
export function describeSubagentModel(
  selection: ModelSelection,
  driverKind: ProviderDriverKind | null,
  models: ReadonlyArray<ServerProviderModel>,
): { readonly modelLabel: string; readonly effortLabel: string | null } {
  const slug = driverKind ? normalizeModelSlug(selection.model, driverKind) : selection.model;
  const model = models.find((candidate) => candidate.slug === slug);
  if (!model) return { modelLabel: selection.model, effortLabel: null };
  const modelLabel = getTriggerDisplayModelName(model);
  if (!model.capabilities) return { modelLabel, effortLabel: null };
  const descriptors = getProviderOptionDescriptors({
    caps: model.capabilities,
    selections: selection.options,
  });
  let effortLabel: string | null = null;
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const descriptor = descriptors.find((candidate) => candidate.id === id);
    if (descriptor?.type !== "select") continue;
    effortLabel = getProviderOptionCurrentLabel(descriptor) ?? null;
    if (effortLabel) break;
  }
  return { modelLabel, effortLabel };
}
