/**
 * Confirmed layer of the local replica: exactly what Convex has accepted up to the persisted
 * cursor, with no optimistic state mixed in.
 *
 * Everything here is pure so the same fold runs on startup (rows from disk), on a drained page,
 * and on a full bootstrap. Server order decides every conflict — the feed carries whole entities
 * in version order, so "later Convex-accepted operation wins for the same field" needs no
 * timestamps and no client clock.
 *
 * @module sync/replica
 */
import type {
  AuthorizationEpoch,
  CompanyVersion,
  SyncChangeEnvelope,
} from "@spiritdevs/contracts/cloudSync";
import * as Option from "effect/Option";

import type { SyncDomainAdapter } from "./adapter.ts";
import type { StoredSyncEntity } from "./document.ts";
import { syncEntityKey, type SyncEntityKey } from "./model.ts";

export interface ConfirmedEntity<Entity> {
  readonly key: SyncEntityKey;
  readonly version: CompanyVersion;
  readonly entity: Entity;
}

export interface ConfirmedReplica<Entity> {
  readonly cursor: CompanyVersion;
  readonly authorizationEpoch: AuthorizationEpoch;
  readonly entities: ReadonlyMap<string, ConfirmedEntity<Entity>>;
}

export function emptyConfirmedReplica<Entity>(input: {
  readonly cursor: CompanyVersion;
  readonly authorizationEpoch: AuthorizationEpoch;
}): ConfirmedReplica<Entity> {
  return {
    cursor: input.cursor,
    authorizationEpoch: input.authorizationEpoch,
    entities: new Map(),
  };
}

export interface ConfirmedChangeResult<Entity> {
  readonly replica: ConfirmedReplica<Entity>;
  /** Rows to persist, carrying the payload exactly as it arrived — no re-encoding round trip. */
  readonly upserts: ReadonlyArray<StoredSyncEntity>;
  readonly deletes: ReadonlyArray<SyncEntityKey>;
  /** Changes this build could not decode. They are skipped, never applied as deletes. */
  readonly quarantined: number;
}

/** Rebuilds the confirmed map from persisted rows, dropping rows this build cannot decode. */
export function decodeConfirmedEntities<Entity, Operation>(input: {
  readonly adapter: SyncDomainAdapter<Entity, Operation>;
  readonly rows: ReadonlyArray<StoredSyncEntity>;
  readonly cursor: CompanyVersion;
  readonly authorizationEpoch: AuthorizationEpoch;
}): { readonly replica: ConfirmedReplica<Entity>; readonly quarantined: number } {
  const entities = new Map<string, ConfirmedEntity<Entity>>();
  let quarantined = 0;
  for (const row of input.rows) {
    const key = { entityKind: row.entityKind, entityId: row.entityId };
    const codec = input.adapter.entityCodec(row.entityKind);
    const decoded = codec === null ? Option.none<Entity>() : codec.decode(row.payload);
    if (Option.isNone(decoded)) {
      quarantined += 1;
      continue;
    }
    entities.set(syncEntityKey(key), { key, version: row.version, entity: decoded.value });
  }
  return {
    replica: {
      cursor: input.cursor,
      authorizationEpoch: input.authorizationEpoch,
      entities,
    },
    quarantined,
  };
}

/**
 * Folds one page of changes into the confirmed replica.
 *
 * A change at or below the current cursor is a redelivery and is ignored, which is what makes a
 * retried page idempotent. Within a page the highest version per entity wins.
 */
export function applyConfirmedChanges<Entity, Operation>(input: {
  readonly replica: ConfirmedReplica<Entity>;
  readonly adapter: SyncDomainAdapter<Entity, Operation>;
  readonly changes: ReadonlyArray<SyncChangeEnvelope>;
  readonly cursor: CompanyVersion;
  readonly authorizationEpoch: AuthorizationEpoch;
}): ConfirmedChangeResult<Entity> {
  const entities = new Map(input.replica.entities);
  const upserts = new Map<string, StoredSyncEntity>();
  const deletes = new Map<string, SyncEntityKey>();
  const merge = input.adapter.mergeConfirmed;
  let quarantined = 0;

  for (const change of input.changes) {
    if (change.version <= input.replica.cursor) continue;
    const key = { entityKind: change.entityKind, entityId: change.entityId };
    const mapKey = syncEntityKey(key);
    const current = entities.get(mapKey);
    if (current !== undefined && current.version > change.version) continue;

    // A tombstone always wins locally. `mergeConfirmed` only guards live entities; a domain that
    // wants a delete to survive as a record models that as an entity field, not as a local ghost.
    if (change.changeKind === "tombstone") {
      entities.delete(mapKey);
      upserts.delete(mapKey);
      deletes.set(mapKey, key);
      continue;
    }

    const codec = input.adapter.entityCodec(change.entityKind);
    const decoded = codec === null ? Option.none<Entity>() : codec.decode(change.payload);
    if (Option.isNone(decoded)) {
      quarantined += 1;
      continue;
    }
    const entity =
      merge === undefined
        ? decoded.value
        : merge({ current: current?.entity ?? null, incoming: decoded.value });
    entities.set(mapKey, { key, version: change.version, entity });
    deletes.delete(mapKey);
    upserts.set(mapKey, {
      entityKind: change.entityKind,
      entityId: change.entityId,
      version: change.version,
      payload: change.payload,
    });
  }

  return {
    replica: {
      cursor: input.cursor,
      authorizationEpoch: input.authorizationEpoch,
      entities,
    },
    upserts: [...upserts.values()],
    deletes: [...deletes.values()],
    quarantined,
  };
}
