// Adapted from t3code #9895 (MIT), https://github.com/pingdotgg/t3code/pull/9895.
import type { HostResourcesSnapshot } from "@spiritdevs/contracts";

export interface LoadBalancingCandidate {
  readonly environmentId: string;
  readonly resources: HostResourcesSnapshot | null;
  /** Client receipt time avoids comparing clocks on different machines. */
  readonly receivedAt?: number;
  readonly weight: number;
}

function tieRank(seed: string, environmentId: string): number {
  let hash = 2166136261;
  for (const character of `${seed}:${environmentId}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

/** Callers supply only connected environments with an eligible project and provider/account. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<LoadBalancingCandidate>,
  now: number,
  seed?: string,
  options?: { readonly avoidCriticalStorage?: boolean },
): string | null {
  if (!Number.isFinite(now)) return null;
  let selected: string | null = null;
  let bestScore = 0;
  let selectedCritical = false;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      !Number.isFinite(sampledAt) ||
      now - sampledAt > 15_000 ||
      sampledAt > now + 5_000 ||
      resources.cpuUtilization === null ||
      !Number.isFinite(resources.cpuUtilization) ||
      resources.cpuUtilization < 0 ||
      resources.cpuUtilization >= 0.95 ||
      !Number.isSafeInteger(resources.totalMemoryBytes) ||
      resources.totalMemoryBytes <= 0 ||
      !Number.isSafeInteger(resources.availableMemoryBytes) ||
      resources.availableMemoryBytes < 0 ||
      resources.availableMemoryBytes > resources.totalMemoryBytes ||
      !Number.isSafeInteger(resources.cpuCount) ||
      resources.cpuCount <= 0
    )
      continue;
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes;
    if (memoryAvailable <= 0.05) continue;
    const score = weight * resources.cpuCount * (1 - resources.cpuUtilization) * memoryAvailable;
    if (!Number.isFinite(score)) continue;
    const storageReceivedAt =
      resources.storageSampledAt === undefined
        ? null
        : sampledAt + resources.storageSampledAt - resources.sampledAt;
    // Storage remains advisory. Prefer a noncritical eligible machine when the
    // user opts in, but retain a critical candidate if it is the only choice.
    const critical =
      options?.avoidCriticalStorage === true &&
      resources.storagePressure === "critical" &&
      storageReceivedAt !== null &&
      Number.isFinite(storageReceivedAt) &&
      now - storageReceivedAt <= 120_000 &&
      storageReceivedAt <= now + 5_000;
    if (
      selected === null ||
      (selectedCritical && !critical) ||
      (selectedCritical === critical &&
        (score > bestScore ||
          (score === bestScore &&
            seed !== undefined &&
            selected !== null &&
            tieRank(seed, environmentId) > tieRank(seed, selected))))
    ) {
      selected = environmentId;
      bestScore = score;
      selectedCritical = critical;
    }
  }
  return selected;
}
