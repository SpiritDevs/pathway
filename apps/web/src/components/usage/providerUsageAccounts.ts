import type { EnvironmentId, ProviderUsageDriver, ServerProvider } from "@spiritdevs/contracts";

import { deriveProviderInstanceEntries } from "../../providerInstances";

const SUPPORTED_PROVIDERS = new Set<ProviderUsageDriver>(["codex", "claudeAgent", "cursor"]);

function isProviderUsageDriver(driver: string): driver is ProviderUsageDriver {
  return SUPPORTED_PROVIDERS.has(driver as ProviderUsageDriver);
}

export interface ConnectedProviderUsageEnvironment {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel?: string;
  readonly providers: ReadonlyArray<ServerProvider> | null;
}

export interface ConnectedProviderUsageAccount {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly provider: ServerProvider;
  readonly displayName: string;
}

function providerUsageAccountKey(environmentId: EnvironmentId, provider: ServerProvider): string {
  // Email does not identify a subscription: personal and team accounts can
  // share it. Keep routing identities separate until providers expose a stable
  // subscription/account id in the auth contract.
  return `${environmentId}:instance:${provider.instanceId}`;
}

/** Preserve every configured account and its environment-owned live stream. */
export function deriveConnectedProviderUsageAccounts(
  environments: ReadonlyArray<ConnectedProviderUsageEnvironment>,
): ReadonlyArray<ConnectedProviderUsageAccount> {
  const accounts = new Map<string, ConnectedProviderUsageAccount>();

  for (const environment of environments) {
    if (environment.providers === null) continue;
    for (const entry of deriveProviderInstanceEntries(environment.providers)) {
      if (!entry.enabled || !entry.installed || !isProviderUsageDriver(entry.driverKind)) continue;
      const key = providerUsageAccountKey(environment.environmentId, entry.snapshot);
      if (accounts.has(key)) continue;
      accounts.set(key, {
        key,
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel ?? environment.environmentId,
        provider: entry.snapshot,
        displayName: entry.displayName,
      });
    }
  }

  return [...accounts.values()];
}

export { isProviderUsageDriver };
