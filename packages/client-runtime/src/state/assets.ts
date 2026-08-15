import {
  type AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const ASSET_URL_REFRESH_INTERVAL_MS = 30 * 60_000;
const ASSET_URL_STALE_TIME_MS = 5 * 60_000;
const ASSET_URL_EXPIRY_SAFETY_WINDOW_MS = 60_000;
// A signed asset URL is a short-lived capability, not durable client state. Dispose it as soon as
// the last view releases it so reopening that view mints a new URL instead of reviving one that may
// be at the end of its server-side lifetime. Mounted consumers still share and refresh one query.
const ASSET_URL_IDLE_TTL_MS = 0;

export class InvalidAssetCollectionKeyError extends Schema.TaggedErrorClass<InvalidAssetCollectionKeyError>()(
  "InvalidAssetCollectionKeyError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid asset collection atom key: ${JSON.stringify(this.key)}.`;
  }
}

const decodeAssetCollectionKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);

export function parseAssetCollectionKey(
  key: string,
): readonly [EnvironmentId, ReadonlyArray<AssetResource>] {
  try {
    return decodeAssetCollectionKey(JSON.parse(key));
  } catch (cause) {
    throw new InvalidAssetCollectionKeyError({ key, cause });
  }
}

export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    return new URL(relativeUrl, httpBaseUrl).toString();
  } catch {
    return null;
  }
}

/** Refuse a capability close enough to expiry that an asset request could race its deadline. */
export function resolveCurrentAssetUrl(
  httpBaseUrl: string,
  result: AssetCreateUrlResult,
  now: number,
): string | null {
  if (result.expiresAt <= now + ASSET_URL_EXPIRY_SAFETY_WINDOW_MS) return null;
  return resolveAssetUrl(httpBaseUrl, result.relativeUrl);
}

export function createAssetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const createUrl = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:assets:create-url",
    tag: WS_METHODS.assetsCreateUrl,
    staleTimeMs: ASSET_URL_STALE_TIME_MS,
    idleTtlMs: ASSET_URL_IDLE_TTL_MS,
    refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
  });
  const createUrlsFamily = Atom.family((key: string) => {
    const [environmentId, resources] = parseAssetCollectionKey(key);
    return Atom.make((get) =>
      resources.map((resource) =>
        get(
          createUrl({
            environmentId,
            input: { resource },
          }),
        ),
      ),
    ).pipe(
      Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS),
      Atom.withLabel(`environment-data:assets:create-urls:${key}`),
    );
  });

  return {
    createUrl,
    createUrls: (target: {
      readonly environmentId: EnvironmentId;
      readonly resources: ReadonlyArray<AssetResource>;
    }) => createUrlsFamily(JSON.stringify([target.environmentId, target.resources])),
  };
}
