import type {
  EnvironmentId,
  ProviderUsageDriver,
  ServerProvider,
  ServerProviderUsageSnapshot,
} from "@spiritdevs/contracts";

import { deriveProviderInstanceEntries } from "../../providerInstances";

const SUPPORTED_PROVIDERS = new Set<ProviderUsageDriver>(["codex", "claudeAgent", "cursor"]);

function isProviderUsageDriver(driver: string): driver is ProviderUsageDriver {
  return SUPPORTED_PROVIDERS.has(driver as ProviderUsageDriver);
}

export interface ConnectedProviderUsageEnvironment {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel?: string;
  readonly usage?: ReadonlyArray<ServerProviderUsageSnapshot>;
  readonly providers: ReadonlyArray<ServerProvider> | null;
}

export interface ConnectedProviderUsageAccount {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly snapshot: ServerProviderUsageSnapshot | null;
}

/** Group known subscriptions and use the freshest successful snapshot for each account. */
export function deriveConnectedProviderUsageAccounts(
  environments: ReadonlyArray<ConnectedProviderUsageEnvironment>,
): ReadonlyArray<ConnectedProviderUsageAccount> {
  const accounts = new Map<string, ConnectedProviderUsageAccount>();

  for (const environment of environments) {
    if (environment.providers === null) continue;
    for (const entry of deriveProviderInstanceEntries(environment.providers)) {
      if (!entry.enabled || !entry.installed || !isProviderUsageDriver(entry.driverKind)) continue;
      const snapshot =
        environment.usage?.find(
          (usage) => usage.instanceId === entry.instanceId && usage.provider === entry.driverKind,
        ) ?? null;
      const key = snapshot?.accountKey
        ? JSON.stringify([entry.driverKind, snapshot.accountKey])
        : JSON.stringify([environment.environmentId, entry.instanceId]);
      const existing = accounts.get(key);
      const candidate = {
        key,
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel ?? environment.environmentId,
        provider: entry.snapshot,
        displayName: entry.displayName,
        snapshot,
      };
      const preferCandidate =
        !existing ||
        (snapshot?.status === "ok" && existing.snapshot?.status !== "ok") ||
        (snapshot?.status === existing.snapshot?.status &&
          Number(snapshot?.stale ?? false) < Number(existing.snapshot?.stale ?? false)) ||
        (snapshot?.status === existing.snapshot?.status &&
          Boolean(snapshot?.stale) === Boolean(existing.snapshot?.stale) &&
          Date.parse(snapshot?.updatedAt ?? "") > Date.parse(existing.snapshot?.updatedAt ?? ""));
      accounts.set(key, preferCandidate ? candidate : existing);
    }
  }

  return [...accounts.values()];
}

export { isProviderUsageDriver };
