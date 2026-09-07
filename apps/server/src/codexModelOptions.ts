import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ModelCapabilities, ModelSelection, ServerProviderModel } from "@spiritdevs/contracts";
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

/** Reads the provider's current discovery snapshot without querying the CLI per turn. */
export class CodexModelCatalog extends Context.Service<
  CodexModelCatalog,
  { readonly getModel: (model: string) => Effect.Effect<ServerProviderModel | undefined> }
>()("@spiritdevs/pathway/codexModelOptions/CodexModelCatalog") {}

export function resolveCodexTurnOptions(
  selection: ModelSelection,
  capabilities?: ModelCapabilities,
) {
  const resolve = (id: string, selected: string | undefined) => {
    if (capabilities === undefined) return selected;
    const descriptor = capabilities.optionDescriptors?.find((option) => option.id === id);
    if (descriptor?.type !== "select") return undefined;
    const allowed = (value: string | undefined) =>
      value !== undefined && descriptor.options.some((option) => option.id === value);
    if (allowed(selected)) return selected;
    if (allowed(descriptor.currentValue)) return descriptor.currentValue;
    return descriptor.options.find((option) => option.isDefault)?.id;
  };
  return {
    effort: resolve(
      "reasoningEffort",
      getModelSelectionStringOptionValue(selection, "reasoningEffort"),
    ),
    serviceTier: resolve("serviceTier", getCodexServiceTierOptionValue(selection)),
  };
}
