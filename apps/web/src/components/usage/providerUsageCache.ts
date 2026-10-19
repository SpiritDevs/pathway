import { ServerProviderUsageSnapshot, type EnvironmentId } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

const STORAGE_KEY = "pathway:provider-usage-cache:v1";
const RememberedProviderUsage = Schema.Record(
  Schema.String,
  Schema.Array(ServerProviderUsageSnapshot),
);
type RememberedProviderUsage = typeof RememberedProviderUsage.Type;

let remembered: RememberedProviderUsage | null = null;

function load(): RememberedProviderUsage {
  if (remembered === null) {
    try {
      remembered = getLocalStorageItem(STORAGE_KEY, RememberedProviderUsage) ?? {};
    } catch {
      remembered = {};
    }
  }
  return remembered;
}

/** Last usage list an environment sent, shown while a new subscription waits for its first reading. */
export function readRememberedProviderUsage(
  environmentId: EnvironmentId,
): ReadonlyArray<ServerProviderUsageSnapshot> | undefined {
  return load()[environmentId];
}

export function rememberProviderUsage(
  environmentId: EnvironmentId,
  usage: ReadonlyArray<ServerProviderUsageSnapshot>,
): void {
  const current = load();
  if (current[environmentId] === usage) return;
  remembered = { ...current, [environmentId]: usage };
  try {
    setLocalStorageItem(STORAGE_KEY, remembered, RememberedProviderUsage);
  } catch {
    // Storage only speeds up first paint; live usage still renders without it.
  }
}

export function resetRememberedProviderUsage(): void {
  remembered = {};
}
