import type { ModelSelection, ProviderInstanceId } from "@spiritdevs/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { isProviderInstancePickerReady } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

export function resolveInitialContinuationSelection(input: {
  readonly kind: "continue" | "handoff" | "recovery";
  readonly source: ModelSelection;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
}): ModelSelection | null {
  if (input.kind === "continue") return input.source;
  const sourceEntry = input.instanceEntries.find(
    (entry) => entry.instanceId === input.source.instanceId,
  );
  const alternatives = input.instanceEntries
    .filter(
      (entry) =>
        entry.instanceId !== input.source.instanceId && isProviderInstancePickerReady(entry),
    )
    .toSorted(
      (left, right) =>
        Number(left.driverKind === sourceEntry?.driverKind) -
        Number(right.driverKind === sourceEntry?.driverKind),
    );
  for (const entry of alternatives) {
    const model = input.modelOptionsByInstance.get(entry.instanceId)?.[0];
    if (model) return { instanceId: entry.instanceId, model: model.slug };
  }
  if (input.kind === "recovery" && sourceEntry && isProviderInstancePickerReady(sourceEntry)) {
    const alternateModel = input.modelOptionsByInstance
      .get(sourceEntry.instanceId)
      ?.find((model) => model.slug !== input.source.model);
    if (alternateModel) return { instanceId: sourceEntry.instanceId, model: alternateModel.slug };
  }
  return null;
}
