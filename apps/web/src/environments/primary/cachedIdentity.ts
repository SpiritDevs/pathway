import { EnvironmentId } from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const CachedPrimaryIdentity = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
});
const decodeIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(CachedPrimaryIdentity));

export function primaryIdentityStorageKey(scope: string, httpBaseUrl: string): string {
  return `pathway:cloud-sync/${scope}/primary-environment/${encodeURIComponent(httpBaseUrl)}`;
}

export function readCachedPrimaryIdentity(scope: string, httpBaseUrl: string) {
  try {
    const raw = window.localStorage.getItem(primaryIdentityStorageKey(scope, httpBaseUrl));
    return raw === null ? null : Option.getOrNull(decodeIdentity(raw));
  } catch {
    return null;
  }
}

export function persistPrimaryIdentity(
  scope: string,
  httpBaseUrl: string,
  identity: typeof CachedPrimaryIdentity.Type,
): void {
  try {
    window.localStorage.setItem(
      primaryIdentityStorageKey(scope, httpBaseUrl),
      JSON.stringify(identity),
    );
  } catch {
    // Storage is optional; a cold launch discovers the live identity instead.
  }
}
