/**
 * The sign-out reset marker and the account-scoped localStorage sweep.
 *
 * Signing out must leave no cloud data behind: the next sign-in for this account starts from an
 * empty replica and re-bootstraps everything from Convex. The wipe itself cannot run at sign-out —
 * the sync runtime may still hold the replica databases open, and a `deleteDatabase` that lands
 * after a quick re-sign-in could destroy a freshly bootstrapped replica. So signing out only
 * writes a durable marker; the sync runtime consumes it on its next leadership pass — when it is
 * the one writer — by discarding every replica database and every scoped storage key before it
 * connects.
 *
 * The marker lives outside the `pathway:cloud-sync/<scope>/` namespace on purpose: the sweep
 * removes that whole namespace, and a swept marker would cancel a wipe nobody performed yet.
 *
 * @module cloud/syncReset
 */
import { SYNC_INDEXED_DB_PREFIX } from "@spiritdevs/client-runtime/sync";

/** The slice of `Storage` the marker and the sweep need; a test passes a plain object. */
export interface SyncResetStorage {
  readonly length: number;
  readonly getItem: (key: string) => string | null;
  readonly key: (index: number) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

function ambientLocalStorage(): SyncResetStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage access can throw outright (a blocked third-party context, a hardened profile).
    return null;
  }
}

/** `pathway:cloud-sync-reset/<scope>` — deliberately outside the swept replica namespace. */
export function cloudSyncResetMarkerKey(scope: string): string {
  return `${SYNC_INDEXED_DB_PREFIX}-reset/${scope}`;
}

function namespacePrefix(scope: string): string {
  return `${SYNC_INDEXED_DB_PREFIX}/${scope}/`;
}

/**
 * Marks the scope's local replica for discard at the next sign-in. Best effort: without usable
 * storage the next sign-in resumes incrementally instead of reseeding, which stays correct.
 */
export function markCloudSyncReset(
  scope: string,
  storage: SyncResetStorage | null = ambientLocalStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(cloudSyncResetMarkerKey(scope), "pending");
  } catch {
    // Private-mode quota errors: an unmarked sign-out degrades to incremental resume.
  }
}

/** Whether a sign-out marked this scope's replica for discard. */
export function readCloudSyncReset(
  scope: string,
  storage: SyncResetStorage | null = ambientLocalStorage(),
): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(cloudSyncResetMarkerKey(scope)) !== null;
  } catch {
    return false;
  }
}

/** Clears the marker; only called once the wipe it asked for has actually happened. */
export function clearCloudSyncReset(
  scope: string,
  storage: SyncResetStorage | null = ambientLocalStorage(),
): void {
  if (storage === null) return;
  try {
    storage.removeItem(cloudSyncResetMarkerKey(scope));
  } catch {
    // A marker that survives here only causes one redundant wipe at the next sign-in.
  }
}

/**
 * Removes every storage key in the scope's replica namespace — the sync client id, the active
 * company selection, anything future keys add — and returns how many were removed. The reset
 * marker is outside this namespace and survives.
 */
export function clearCloudSyncNamespaceKeys(
  scope: string,
  storage: SyncResetStorage | null = ambientLocalStorage(),
): number {
  if (storage === null) return 0;
  const prefix = namespacePrefix(scope);
  let removed = 0;
  try {
    // Copy first: mutating a live Storage key list while iterating it skips entries.
    const keys: Array<string> = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      storage.removeItem(key);
      removed += 1;
    }
  } catch {
    // Whatever remains is account-scoped and inert; the replica wipe below still holds.
  }
  return removed;
}
