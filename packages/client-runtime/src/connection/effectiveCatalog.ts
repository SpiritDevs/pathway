/**
 * The connectable catalog seen by clients: device-local configuration overlaid with company
 * environment discovery from the cloud replica.
 *
 * @module connection/effectiveCatalog
 */
import { isPathwayEnvironmentDescriptor, type EnvironmentId } from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistrationEntity } from "../sync/companyDomain.ts";
import { type ConnectionCatalogEntry, type ConnectionCatalogFreshness } from "./catalog.ts";
import { RelayConnectionTarget } from "./model.ts";

export type EffectiveConnectionCatalogEntry =
  | (ConnectionCatalogEntry & {
      readonly source: "local";
    })
  | (ConnectionCatalogEntry & {
      readonly source: "companyRegistry";
      readonly target: RelayConnectionTarget;
      readonly freshness: ConnectionCatalogFreshness;
    });

/** The part of sync engine state the catalog needs; tests and non-engine replicas can provide it. */
export interface CompanyRegistryReplicaState {
  readonly view: ReadonlyMap<string, unknown>;
}

export interface EffectiveConnectionCatalogInput {
  readonly localEntries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  readonly replica: CompanyRegistryReplicaState | null;
  readonly currentEnvironmentId?: EnvironmentId | null;
}

const isEnvironmentRegistrationEntity = Schema.is(EnvironmentRegistrationEntity);

function registryEntries(
  replica: CompanyRegistryReplicaState | null,
): ReadonlyMap<EnvironmentId, EnvironmentRegistrationEntity> {
  if (replica === null) return new Map();
  const registrations = new Map<EnvironmentId, EnvironmentRegistrationEntity>();
  for (const entity of replica.view.values()) {
    if (
      isEnvironmentRegistrationEntity(entity) &&
      entity.state === "active" &&
      isPathwayEnvironmentDescriptor(entity.descriptor)
    ) {
      registrations.set(entity.environmentId, entity);
    }
  }
  return registrations;
}

/**
 * Local configuration wins for a duplicate environment id because it may carry credentials or a
 * richer endpoint. The registry contributes only its last-seen observation when that local entry
 * has no freshness of its own; it never replaces local connection configuration.
 */
export function mergeEffectiveConnectionCatalog(
  input: EffectiveConnectionCatalogInput,
): ReadonlyMap<EnvironmentId, EffectiveConnectionCatalogEntry> {
  const registry = registryEntries(input.replica);
  const merged = new Map<EnvironmentId, EffectiveConnectionCatalogEntry>();

  for (const [environmentId, entry] of input.localEntries) {
    const discovered = registry.get(environmentId);
    merged.set(environmentId, {
      ...entry,
      source: "local",
      ...(entry.descriptor === undefined && discovered !== undefined
        ? { descriptor: discovered.descriptor }
        : {}),
      ...(entry.freshness === undefined && discovered !== undefined
        ? { freshness: { lastSeenAt: discovered.lastSeenAt } }
        : {}),
    });
  }

  for (const registration of registry.values()) {
    if (
      registration.environmentId === input.currentEnvironmentId ||
      merged.has(registration.environmentId)
    ) {
      continue;
    }
    merged.set(registration.environmentId, {
      source: "companyRegistry",
      target: new RelayConnectionTarget({
        environmentId: registration.environmentId,
        label: registration.descriptor.label,
      }),
      profile: Option.none(),
      descriptor: registration.descriptor,
      freshness: { lastSeenAt: registration.lastSeenAt },
    });
  }

  return merged;
}

/**
 * Reuses the catalog and sync engine's existing `SubscriptionRef` change streams. A missing
 * replica is the signed-out/cloud-disabled path and follows the local catalog alone.
 */
export function effectiveConnectionCatalogChanges(input: {
  readonly localEntries: SubscriptionRef.SubscriptionRef<
    ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
  >;
  readonly replica: SubscriptionRef.SubscriptionRef<CompanyRegistryReplicaState> | null;
  readonly currentEnvironmentId?: EnvironmentId | null;
}): Stream.Stream<ReadonlyMap<EnvironmentId, EffectiveConnectionCatalogEntry>> {
  const merge = (
    localEntries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
    replica: CompanyRegistryReplicaState | null,
  ) =>
    mergeEffectiveConnectionCatalog({
      localEntries,
      replica,
      ...(input.currentEnvironmentId === undefined
        ? {}
        : { currentEnvironmentId: input.currentEnvironmentId }),
    });

  if (input.replica === null) {
    return SubscriptionRef.changes(input.localEntries).pipe(
      Stream.map((localEntries) => merge(localEntries, null)),
    );
  }

  return Stream.zipLatest(
    SubscriptionRef.changes(input.localEntries),
    SubscriptionRef.changes(input.replica),
  ).pipe(Stream.map(([localEntries, replica]) => merge(localEntries, replica)));
}
