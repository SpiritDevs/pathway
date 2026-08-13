import type { SessionPhase } from "../../types";

export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;
export type ActiveTurnSendAction = Extract<ActiveTurnComposerAction, "queue" | "steer">;

export function alternateActiveTurnSendAction(action: ActiveTurnSendAction): ActiveTurnSendAction {
  return action === "queue" ? "steer" : "queue";
}

/** Resolve the primary or alternate active-turn action selected in composer settings. */
export function resolveComposerDispatchMode(input: {
  readonly phase: SessionPhase;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
}): ComposerDispatchMode {
  if (input.phase !== "running") return "auto";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) {
    return defaultAction === "restart" ? "queue" : alternateActiveTurnSendAction(defaultAction);
  }
  return defaultAction;
}
