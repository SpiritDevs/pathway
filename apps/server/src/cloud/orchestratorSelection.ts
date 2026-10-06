import type { ModelSelection, ServerProvider } from "@spiritdevs/contracts";
import { isProviderAvailable } from "@spiritdevs/contracts";
import { normalizeModelSlug } from "@spiritdevs/shared/model";
import { delegationSelectionProblem } from "@spiritdevs/contracts/aiOrchestrator";
import * as Schema from "effect/Schema";
import { OrchestratorDelegationCatalog } from "@spiritdevs/contracts/aiOrchestrator";

const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(OrchestratorDelegationCatalog));

export function resolveDelegatedModel(
  requested: ModelSelection | null,
  projectDefault: ModelSelection | null,
  environmentDefault: ModelSelection,
): ModelSelection {
  return requested ?? projectDefault ?? environmentDefault;
}

function isDelegationProviderAvailable(provider: ServerProvider): boolean {
  return (
    isProviderAvailable(provider) &&
    provider.enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status !== "unauthenticated"
  );
}

/**
 * Order the instances offered to coordinator claims. A run without a pinned model takes the first
 * instance of a coordinator driver, so lead with the user's text-generation instance, then usable
 * ones, keeping a signed-out duplicate account from being picked just because it was listed first.
 */
export function coordinatorProviders(
  providers: readonly ServerProvider[],
  preferredInstanceId: string,
): Array<{ instanceId: string; driver: string }> {
  const rank = (provider: ServerProvider) =>
    provider.instanceId === preferredInstanceId
      ? 0
      : isDelegationProviderAvailable(provider)
        ? 1
        : 2;
  return [...providers]
    .sort((left, right) => rank(left) - rank(right))
    .map((provider) => ({ instanceId: provider.instanceId, driver: provider.driver }));
}

/** Read cached discovery only; omit account details and bound coordinator context size. */
export function orchestratorDelegationCatalog(
  providers: readonly ServerProvider[],
  defaultSelection: ModelSelection,
): OrchestratorDelegationCatalog {
  let remaining = 200;
  let truncated = providers.length > 50;
  const entries = providers.slice(0, 50).map((provider) => {
    const models = provider.models.slice(0, Math.min(100, remaining));
    remaining -= models.length;
    truncated ||= models.length < provider.models.length;
    return {
      instanceId: provider.instanceId,
      driver: provider.driver,
      name: provider.displayName ?? provider.driver,
      available: isDelegationProviderAvailable(provider),
      models: models.map((model) => ({
        id: model.slug,
        name: model.name,
        options: model.capabilities?.optionDescriptors ?? [],
      })),
    };
  });
  const catalog = { defaultSelection, truncated, providers: entries };
  // Keep the transport below its 100 KB transport limit and coordinator context budget even for providers with large option catalogs.
  while (
    encodeCatalog(catalog).length > 24000 &&
    entries.some((provider) => provider.models.length)
  ) {
    entries.findLast((provider) => provider.models.length)?.models.pop();
    catalog.truncated = true;
  }
  return catalog;
}

/** Match the runtime's legacy aliases before checking the provider's current discovery. */
export function discoveredDelegationSelectionProblem(
  selection: ModelSelection,
  snapshot: ServerProvider,
) {
  const normalized = {
    ...selection,
    model: normalizeModelSlug(selection.model, snapshot.driver) ?? selection.model,
  };
  const model = snapshot.models.find((model) => model.slug === normalized.model);
  return delegationSelectionProblem(
    normalized,
    orchestratorDelegationCatalog([{ ...snapshot, models: model ? [model] : [] }], normalized),
  );
}
