import type { DictationState } from "@spiritdevs/contracts/dictation";
import { dictationReadiness } from "./dictationUi";

export const dictationSetupSteps = [
  { id: "access", label: "Access" },
  { id: "models", label: "Models" },
  { id: "test", label: "Try it" },
] as const;
export type DictationSetupStep = (typeof dictationSetupSteps)[number]["id"];

export function dictationPermissionCommand(action: "microphone" | "accessibility" | "refresh") {
  return { type: "permissions", action } as const;
}

export function dictationSetupAccessReady(state: DictationState) {
  return (
    state.supported &&
    state.authenticated &&
    state.nativeAvailable &&
    state.microphonePermission === "granted" &&
    (state.platform !== "darwin" || state.accessibilityPermission === "granted")
  );
}

export function dictationSetupModels(state: DictationState) {
  return state.models.filter(
    (model) => model.id === "whisper-turbo" || model.id === "qwen-cleanup",
  );
}

export function dictationSetupModelsReady(state: DictationState) {
  return ["whisper-turbo", "qwen-cleanup"].every((id) =>
    state.models.some((model) => model.id === id && model.status === "installed"),
  );
}

export function dictationSetupCanVisit(state: DictationState, step: DictationSetupStep) {
  if (step === "access") return true;
  return (
    dictationSetupAccessReady(state) && (step === "models" || dictationSetupModelsReady(state))
  );
}

export function dictationSetupInitialStep(
  state: DictationState,
  requested?: DictationSetupStep,
): DictationSetupStep {
  if (!dictationSetupAccessReady(state)) return "access";
  if (requested && dictationSetupCanVisit(state, requested)) return requested;
  return dictationSetupModelsReady(state) ? "test" : "models";
}

export function dictationSetupCanFinish(state: DictationState) {
  return (
    dictationSetupAccessReady(state) &&
    dictationSetupModelsReady(state) &&
    dictationReadiness(state).length === 0 &&
    !["starting", "recording", "processing"].includes(state.phase)
  );
}
