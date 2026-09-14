import type { ModelSelection, ServerProvider } from "@spiritdevs/contracts";
import { isProviderAvailable } from "@spiritdevs/contracts";
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
      available:
        isProviderAvailable(provider) &&
        provider.enabled &&
        provider.installed &&
        provider.status !== "error" &&
        provider.status !== "disabled" &&
        provider.auth.status !== "unauthenticated",
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
