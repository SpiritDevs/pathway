import type { EnvironmentId, ProviderUsageDriver, ServerProvider } from "@spiritdevs/contracts";

import { deriveProviderInstanceEntries } from "../../providerInstances";

const SUPPORTED_PROVIDERS = new Set<ProviderUsageDriver>(["codex", "claudeAgent", "cursor"]);

function isProviderUsageDriver(driver: string): driver is ProviderUsageDriver {
  return SUPPORTED_PROVIDERS.has(driver as ProviderUsageDriver);
}

export interface ConnectedProviderUsageEnvironment {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider> | null;
}

export interface ConnectedProviderUsageAccount {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
}

function providerUsageAccountKey(environmentId: EnvironmentId, provider: ServerProvider): string {
  const email = provider.auth.email?.trim().toLowerCase();
  return email
    ? `${provider.driver}:email:${email}`
    : `${environmentId}:instance:${provider.instanceId}`;
}

/**
 * Project environment-scoped provider snapshots into subscription accounts.
 * Authenticated email is the cross-environment identity providers expose; when
 * it is unavailable, keep the instance separate rather than risking a false
 * merge between two accounts with similar labels or limits.
 */
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
        provider: entry.snapshot,
        displayName: entry.displayName,
      });
    }
  }

  return [...accounts.values()];
}

export { isProviderUsageDriver };
