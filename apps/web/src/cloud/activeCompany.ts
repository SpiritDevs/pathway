import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import type { CompanyId, WorkspaceKind } from "@spiritdevs/contracts/company";
import { Atom } from "effect/unstable/reactivity";

import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { companyRegistryReplicasAtom } from "./companyRegistryReplica";

export interface ActiveCompanyRow {
  readonly id: CompanyId;
  readonly name: string;
  readonly workspaceKind: WorkspaceKind;
  readonly issueKeyPrefix: string;
}

export interface ActiveCompanyStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export function activeCompanyIdStorageKey(scope: string): string {
  return `pathway:cloud-sync/${scope}/active-company-id`;
}

export function resolveActiveCompanyId(
  scope: string | null,
  companies: ReadonlyArray<Pick<ActiveCompanyRow, "id">>,
  preferredId: string | null,
): CompanyId | null {
  if (scope === null || companies.length === 0) return null;
  return companies.find((company) => company.id === preferredId)?.id ?? companies[0]!.id;
}

export function readActiveCompanyId(options: {
  readonly scope: string | null;
  readonly companies: ReadonlyArray<Pick<ActiveCompanyRow, "id">>;
  readonly storage: ActiveCompanyStorage | null;
}): CompanyId | null {
  if (options.scope === null || options.companies.length === 0) return null;

  let persistedId: string | null = null;
  try {
    persistedId = options.storage?.getItem(activeCompanyIdStorageKey(options.scope)) ?? null;
  } catch {
    // A blocked storage API should not make company selection unavailable.
  }

  const activeCompanyId = resolveActiveCompanyId(options.scope, options.companies, persistedId);
  if (activeCompanyId === null) return null;
  if (activeCompanyId !== persistedId && options.storage !== null) {
    try {
      options.storage.setItem(activeCompanyIdStorageKey(options.scope), activeCompanyId);
    } catch {
      // Keep the in-memory fallback when persistence is unavailable.
    }
  }
  return activeCompanyId;
}

export function writeActiveCompanyId(options: {
  readonly scope: string | null;
  readonly companies: ReadonlyArray<Pick<ActiveCompanyRow, "id">>;
  readonly companyId: CompanyId | null;
  readonly storage: ActiveCompanyStorage | null;
}): CompanyId | null {
  const activeCompanyId = resolveActiveCompanyId(
    options.scope,
    options.companies,
    options.companyId,
  );
  if (options.scope === null || activeCompanyId === null || options.storage === null) {
    return activeCompanyId;
  }
  try {
    options.storage.setItem(activeCompanyIdStorageKey(options.scope), activeCompanyId);
  } catch {
    // The selection still applies for this render even if the browser rejects persistence.
  }
  return activeCompanyId;
}

function ambientLocalStorage(): ActiveCompanyStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isReplicaCompanyEntity(value: unknown): value is {
  readonly entityKind: "company";
  readonly name: string;
  readonly workspaceKind?: unknown;
  readonly issueKeyPrefix: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "entityKind" in value &&
    value.entityKind === "company" &&
    "name" in value &&
    typeof value.name === "string" &&
    "issueKeyPrefix" in value &&
    typeof value.issueKeyPrefix === "string"
  );
}

export function companyRowsFromRegistryReplicas(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
): ReadonlyArray<ActiveCompanyRow> {
  const companies: ActiveCompanyRow[] = [];
  for (const [companyId, replica] of replicas) {
    for (const entity of replica.view.values()) {
      if (!isReplicaCompanyEntity(entity)) continue;
      companies.push({
        id: companyId,
        name: entity.name,
        workspaceKind: entity.workspaceKind === "personal" ? "personal" : "organization",
        issueKeyPrefix: entity.issueKeyPrefix,
      });
      break;
    }
  }
  return companies;
}

function sameCompanyRows(
  current: ReadonlyArray<ActiveCompanyRow>,
  next: ReadonlyArray<ActiveCompanyRow>,
): boolean {
  return (
    current.length === next.length &&
    current.every(
      (company, index) =>
        company.id === next[index]?.id &&
        company.name === next[index]?.name &&
        company.workspaceKind === next[index]?.workspaceKind &&
        company.issueKeyPrefix === next[index]?.issueKeyPrefix,
    )
  );
}

export const companyListAtom = Atom.make((get) =>
  companyRowsFromRegistryReplicas(get(companyRegistryReplicasAtom)),
).pipe(Atom.withEquality(sameCompanyRows), Atom.withLabel("cloud-sync:company-list"));

const activeCompanyScopeAtom = Atom.make((get) => {
  // Mirrors cloudSyncScope without importing the intentionally lazy sync runtime into the app UI.
  const accountId = get(managedRelaySessionAtom)?.accountId.trim();
  return accountId ? accountId : null;
}).pipe(Atom.withLabel("cloud-sync:active-company-scope"));

const activeCompanyOverridesAtom = Atom.make<ReadonlyMap<string, CompanyId>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("cloud-sync:active-company-overrides"),
);

export const activeCompanyIdAtom = Atom.writable(
  (get) => {
    const scope = get(activeCompanyScopeAtom);
    const companies = get(companyListAtom);
    const storage = ambientLocalStorage();
    const override = scope === null ? undefined : get(activeCompanyOverridesAtom).get(scope);
    if (override === undefined) {
      return readActiveCompanyId({ scope, companies, storage });
    }

    const activeCompanyId = resolveActiveCompanyId(scope, companies, override);
    if (activeCompanyId !== null && activeCompanyId !== override) {
      writeActiveCompanyId({ scope, companies, companyId: activeCompanyId, storage });
    }
    return activeCompanyId;
  },
  (context, companyId: CompanyId | null) => {
    const scope = context.get(activeCompanyScopeAtom);
    const activeCompanyId = writeActiveCompanyId({
      scope,
      companies: context.get(companyListAtom),
      companyId,
      storage: ambientLocalStorage(),
    });
    if (scope !== null && activeCompanyId !== null) {
      context.set(
        activeCompanyOverridesAtom,
        new Map(context.get(activeCompanyOverridesAtom)).set(scope, activeCompanyId),
      );
    }
    context.refreshSelf();
  },
).pipe(Atom.withLabel("cloud-sync:active-company-id"));

/**
 * The single read/write cutover decision for issue-domain state.
 *
 * A company is replica-routed only after its engine has published a usable replica. Keeping the
 * company id (rather than a boolean) lets mutation commands enqueue into that exact engine while
 * the list projection reads from the same replica-presence signal.
 */
export const activeCompanyReplicaRoutingAtom = Atom.make((get): CompanyId | null => {
  const companyId = get(activeCompanyIdAtom);
  return companyId !== null && get(companyRegistryReplicasAtom).has(companyId) ? companyId : null;
}).pipe(Atom.withLabel("cloud-sync:active-company-replica-routing"));

export const activeCompanyAtom = Atom.make((get): ActiveCompanyRow | null => {
  const activeCompanyId = get(activeCompanyIdAtom);
  return get(companyListAtom).find((company) => company.id === activeCompanyId) ?? null;
}).pipe(Atom.withLabel("cloud-sync:active-company"));
