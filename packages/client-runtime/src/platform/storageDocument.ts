import * as Schema from "effect/Schema";

import {
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
} from "../connection/catalog.ts";
import { type ConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";
import * as TokenStore from "../authorization/tokenStore.ts";

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

export const ConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
});
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
});

export function replaceCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  next: A,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function removeCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  removedKey: string,
): ReadonlyArray<A> {
  return values.filter((value) => key(value) !== removedKey);
}

function connectionIdOf(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

function removeConnectionMetadata(
  document: ConnectionCatalogDocument,
  target: ConnectionTarget,
  removeRemoteToken: boolean,
): ConnectionCatalogDocument {
  const connectionId = connectionIdOf(target);
  return {
    ...document,
    targets: removeCatalogValue(
      document.targets,
      (value) => value.environmentId,
      target.environmentId,
    ),
    profiles:
      connectionId === null
        ? document.profiles
        : removeCatalogValue(document.profiles, (value) => value.connectionId, connectionId),
    credentials:
      connectionId === null
        ? document.credentials
        : removeCatalogValue(document.credentials, (value) => value.connectionId, connectionId),
    remoteDpopTokens: removeRemoteToken
      ? removeCatalogValue(
          document.remoteDpopTokens,
          (value) => value.environmentId,
          target.environmentId,
        )
      : document.remoteDpopTokens,
  };
}

export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
): ConnectionCatalogDocument {
  const target = registration.target;
  const previous = document.targets.find(
    (candidate) => candidate.environmentId === target.environmentId,
  );
  const cleaned =
    previous === undefined ? document : removeConnectionMetadata(document, previous, false);

  // Pathway Connect environments belong to the Convex-backed company registry. A relay
  // registration is only a request to connect during this client session; persisting it would
  // leak the previous account's environment list into a later account or clean installation.
  if (registration._tag === "RelayConnectionRegistration") {
    return cleaned;
  }

  const next: ConnectionCatalogDocument = {
    ...cleaned,
    targets: replaceCatalogValue(cleaned.targets, (value) => value.environmentId, target),
  };

  switch (registration._tag) {
    case "BearerConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
        credentials: replaceCatalogValue(next.credentials, (value) => value.connectionId, {
          connectionId: registration.target.connectionId,
          credential: registration.credential,
        }),
      };
    case "SshConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
      };
  }
}

/** Drops legacy device-local relay targets now owned by the company environment registry. */
export function removePersistedRelayConnections(
  document: ConnectionCatalogDocument,
): ConnectionCatalogDocument {
  const relayTargets = document.targets.filter((target) => target._tag === "RelayConnectionTarget");
  if (relayTargets.length === 0) return document;
  return relayTargets.reduce(
    (current, target) => removeConnectionMetadata(current, target, false),
    document,
  );
}

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  target: ConnectionTarget,
): ConnectionCatalogDocument {
  return removeConnectionMetadata(document, target, true);
}
