/**
 * The browser-storage namespace every web-platform sync artifact lives under: IndexedDB database
 * names (`indexedDbStore.ts`) and Web Locks leader-lock names (`webLeader.ts`) both start with
 * this prefix, fixed by the sync plan.
 *
 * This lives in its own DOM-free module so `webLeader.ts` (structural, usable without the DOM
 * lib) can share it without importing `indexedDbStore.ts`, which names ambient DOM types and
 * would break consumers compiled without `lib: ["DOM"]`.
 *
 * @module sync/webNamespace
 */

/** Database and lock name prefix fixed by the plan: `pathway:cloud-sync`. */
export const SYNC_INDEXED_DB_PREFIX = "pathway:cloud-sync";
