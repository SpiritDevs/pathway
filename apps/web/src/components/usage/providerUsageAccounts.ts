import type {
  EnvironmentId,
  ProviderUsageDriver,
  ProviderInstanceId,
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
  readonly receivedAt?: number;
  readonly snapshotReceivedAt?: ReadonlyMap<ProviderInstanceId, number>;
  readonly resetCreditsReceivedAt?: ReadonlyMap<ProviderInstanceId, number>;
  readonly usage?: ReadonlyArray<ServerProviderUsageSnapshot>;
  readonly providers: ReadonlyArray<ServerProvider> | null;
}

export interface ConnectedProviderUsageAccount {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly receivedAt: number;
  readonly snapshot: ServerProviderUsageSnapshot | null;
}

/** Keep unchanged quota values at their original client arrival time across list broadcasts. */
export function createProviderUsageArrivalTracker() {
  const observed = new Map<string, { fingerprint: string; receivedAt: number }>();
  const observedCredits = new Map<string, { fingerprint: string; receivedAt: number }>();
  return (environments: ReadonlyArray<ConnectedProviderUsageEnvironment>) => {
    const active = new Set<string>();
    const result = environments.map((environment) => {
      const snapshotReceivedAt = new Map<ProviderInstanceId, number>();
      const resetCreditsReceivedAt = new Map<ProviderInstanceId, number>();
      for (const snapshot of environment.usage ?? []) {
        const key = JSON.stringify([environment.environmentId, snapshot.instanceId]);
        active.add(key);
        const fingerprint = JSON.stringify(snapshot);
        const previous = observed.get(key);
        const receivedAt =
          previous?.fingerprint === fingerprint
            ? previous.receivedAt
            : (environment.receivedAt ?? 0);
        observed.set(key, { fingerprint, receivedAt });
        snapshotReceivedAt.set(snapshot.instanceId, receivedAt);
        const creditFingerprint = JSON.stringify([
          snapshot.accountKey,
          snapshot.resetCredits?.availableCount,
          snapshot.resetCredits?.credits,
          snapshot.resetCredits?.nextExpiresAt,
        ]);
        const previousCredits = observedCredits.get(key);
        const creditsReceivedAt =
          previousCredits?.fingerprint === creditFingerprint
            ? previousCredits.receivedAt
            : (environment.receivedAt ?? 0);
        observedCredits.set(key, { fingerprint: creditFingerprint, receivedAt: creditsReceivedAt });
        resetCreditsReceivedAt.set(snapshot.instanceId, creditsReceivedAt);
      }
      return { ...environment, snapshotReceivedAt, resetCreditsReceivedAt };
    });
    for (const key of observed.keys()) if (!active.has(key)) observed.delete(key);
    for (const key of observedCredits.keys()) if (!active.has(key)) observedCredits.delete(key);
    return result;
  };
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
        receivedAt:
          environment.snapshotReceivedAt?.get(entry.instanceId) ?? environment.receivedAt ?? 0,
      };
      const preferCandidate =
        !existing ||
        (snapshot?.status === "ok" && existing.snapshot?.status !== "ok") ||
        (snapshot?.status === existing.snapshot?.status &&
          Number(snapshot?.stale ?? false) < Number(existing.snapshot?.stale ?? false)) ||
        (snapshot?.status === existing.snapshot?.status &&
          Boolean(snapshot?.stale) === Boolean(existing.snapshot?.stale) &&
          candidate.receivedAt > existing.receivedAt);
      accounts.set(key, preferCandidate ? candidate : existing);
    }
  }

  return [...accounts.values()];
}

/** Route credits through an environment that reports them, including an empty balance. */
export function deriveConnectedProviderResetCreditAccounts(
  environments: ReadonlyArray<ConnectedProviderUsageEnvironment>,
): ReadonlyArray<ConnectedProviderUsageAccount> {
  return deriveConnectedProviderUsageAccounts(
    environments.map((environment) => ({
      ...environment,
      ...(environment.resetCreditsReceivedAt
        ? { snapshotReceivedAt: environment.resetCreditsReceivedAt }
        : {}),
      providers:
        environment.providers?.filter((provider) =>
          environment.usage?.some(
            (snapshot) =>
              snapshot.instanceId === provider.instanceId &&
              snapshot.provider === "codex" &&
              snapshot.resetCredits !== undefined,
          ),
        ) ?? null,
    })),
  );
}

export { isProviderUsageDriver };
