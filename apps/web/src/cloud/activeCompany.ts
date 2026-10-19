import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import { CompanyId, type WorkspaceKind } from "@spiritdevs/contracts/company";
import { Atom } from "effect/unstable/reactivity";

import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { companyRegistryReplicasAtom } from "./companyRegistryReplica";

export const ALL_COMPANIES_SCOPE = "all" as const;

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
  if (scope === null || preferredId === ALL_COMPANIES_SCOPE) return null;
  // A persisted concrete selection is authoritative even before (or between) replica listings.
  // Keeping the id makes every scoped projection fail closed until that exact replica returns.
  if (preferredId !== null) return CompanyId.make(preferredId);
  // This is only an implicit compatibility fallback. It is deliberately not persisted, so a
  // staggered second replica changes an account with no preference to All companies.
  return companies.length === 1 ? companies[0]!.id : null;
}

export function readActiveCompanyId(options: {
  readonly scope: string | null;
  readonly companies: ReadonlyArray<Pick<ActiveCompanyRow, "id">>;
  readonly storage: ActiveCompanyStorage | null;
}): CompanyId | null {
  if (options.scope === null) return null;

  let persistedId: string | null = null;
  try {
    persistedId = options.storage?.getItem(activeCompanyIdStorageKey(options.scope)) ?? null;
  } catch {
    // A blocked storage API should not make company selection unavailable.
  }

  return resolveActiveCompanyId(options.scope, options.companies, persistedId);
}

export function writeActiveCompanyId(options: {
  readonly scope: string | null;
  readonly companies: ReadonlyArray<Pick<ActiveCompanyRow, "id">>;
  readonly companyId: CompanyId | null;
  readonly storage: ActiveCompanyStorage | null;
}): CompanyId | null {
  if (options.scope === null) return null;
  try {
    options.storage?.setItem(
      activeCompanyIdStorageKey(options.scope),
      options.companyId ?? ALL_COMPANIES_SCOPE,
    );
  } catch {
    // The selection still applies for this render even if the browser rejects persistence.
  }
  return options.companyId;
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

const activeCompanyAccountScopeAtom = Atom.make((get) => {
  // Mirrors cloudSyncScope without importing the intentionally lazy sync runtime into the app UI.
  const accountId = get(managedRelaySessionAtom)?.accountId.trim();
  return accountId ? accountId : null;
}).pipe(Atom.withLabel("cloud-sync:active-company-scope"));

const activeCompanyOverridesAtom = Atom.make<ReadonlyMap<string, CompanyId | null>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("cloud-sync:active-company-overrides"),
);

export const activeCompanyIdAtom = Atom.writable(
  (get) => {
    const scope = get(activeCompanyAccountScopeAtom);
    const companies = get(companyListAtom);
    const storage = ambientLocalStorage();
    const overrides = get(activeCompanyOverridesAtom);
    if (scope === null || !overrides.has(scope)) {
      return readActiveCompanyId({ scope, companies, storage });
    }

    return overrides.get(scope) ?? null;
  },
  (context, companyId: CompanyId | null) => {
    const scope = context.get(activeCompanyAccountScopeAtom);
    const activeCompanyId = writeActiveCompanyId({
      scope,
      companies: context.get(companyListAtom),
      companyId,
      storage: ambientLocalStorage(),
    });
    if (scope !== null) {
      context.set(
        activeCompanyOverridesAtom,
        new Map(context.get(activeCompanyOverridesAtom)).set(scope, activeCompanyId),
      );
    }
    context.refreshSelf();
  },
).pipe(Atom.withLabel("cloud-sync:active-company-id"));

export function companyReplicasForSelection(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
  companyId: CompanyId | null,
): ReadonlyMap<CompanyId, CompanyRegistryReplicaState> {
  if (companyId === null) return replicas;
  const replica = replicas.get(companyId);
  return replica === undefined
    ? new Map<CompanyId, CompanyRegistryReplicaState>()
    : new Map([[companyId, replica]]);
}

/** The replicas visible through the account-level All companies/company selection. */
export const scopedCompanyRegistryReplicasAtom = Atom.make((get) => {
  return companyReplicasForSelection(get(companyRegistryReplicasAtom), get(activeCompanyIdAtom));
}).pipe(Atom.withLabel("cloud-sync:scoped-company-registry-replicas"));

/**
 * The selected-company mutation target for callers that do not carry entity provenance.
 *
 * All companies deliberately has no single target. Existing-entity writes must route through the
 * entity's owning replica; creation flows must ask for a concrete company before enqueueing.
 */
export const activeCompanyReplicaRoutingAtom = Atom.make((get): CompanyId | null => {
  const companyId = get(activeCompanyIdAtom);
  return companyId !== null && get(companyRegistryReplicasAtom).has(companyId) ? companyId : null;
}).pipe(Atom.withLabel("cloud-sync:active-company-replica-routing"));

export const activeCompanyAtom = Atom.make((get): ActiveCompanyRow | null => {
  const activeCompanyId = get(activeCompanyIdAtom);
  return get(companyListAtom).find((company) => company.id === activeCompanyId) ?? null;
}).pipe(Atom.withLabel("cloud-sync:active-company"));
