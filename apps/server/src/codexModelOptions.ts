import type { ModelSelection } from "@spiritdevs/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@spiritdevs/shared/model";

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}
