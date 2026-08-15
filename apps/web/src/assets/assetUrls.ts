import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { resolveCurrentAssetUrl } from "@spiritdevs/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@spiritdevs/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useMemo, useRef } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";

export { resolveAssetUrl, resolveCurrentAssetUrl } from "@spiritdevs/client-runtime/state/assets";

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure" }
  | { readonly _tag: "Success"; readonly url: string; readonly sourcePath?: string };

const EMPTY_ASSET_URL_RESULTS_ATOM = Atom.make([]).pipe(Atom.withLabel("web-asset-urls:empty"));

export function useAssetUrlState(
  environmentId: EnvironmentId,
  resource: AssetResource,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const query = assetEnvironment.createUrl({ environmentId, input: { resource } });
  const result = useAtomValue(query);
  if (result._tag === "Failure") {
    return { _tag: "Failure" };
  }
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return { _tag: "Loading" };
  }
  const url = resolveCurrentAssetUrl(
    preparedConnection.value.httpBaseUrl,
    result.value,
    Date.now(),
  );
  return url === null
    ? { _tag: "Failure" }
    : {
        _tag: "Success",
        url,
        ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
      };
}

export interface AssetUrlsState {
  readonly urls: ReadonlyArray<string | null>;
  /** Retry one failed resource once while this view remains mounted. */
  readonly refresh: (index: number) => void;
}

export function useAssetUrlsState(
  environmentId: EnvironmentId | null,
  resources: ReadonlyArray<AssetResource>,
): AssetUrlsState {
  const registry = useContext(RegistryContext);
  const preparedConnection = usePreparedConnection(environmentId);
  const retriedResourcesRef = useRef(new Set<string>());
  const queryAtoms = useMemo(
    () =>
      environmentId === null
        ? []
        : resources.map((resource) =>
            assetEnvironment.createUrl({ environmentId, input: { resource } }),
          ),
    [environmentId, resources],
  );
  const results = useAtomValue(
    environmentId === null
      ? EMPTY_ASSET_URL_RESULTS_ATOM
      : assetEnvironment.createUrls({ environmentId, resources }),
  );
  const refresh = useCallback(
    (index: number) => {
      const query = queryAtoms[index];
      const resource = resources[index];
      if (query === undefined || resource === undefined) return;

      const resourceKey = JSON.stringify([environmentId, resource]);
      if (retriedResourcesRef.current.has(resourceKey)) return;
      retriedResourcesRef.current.add(resourceKey);
      registry.refresh(query);
    },
    [environmentId, queryAtoms, registry, resources],
  );
  const urls = useMemo(() => {
    if (preparedConnection._tag === "None") return resources.map(() => null);
    const now = Date.now();
    return results.map((result) =>
      AsyncResult.isSuccess(result)
        ? resolveCurrentAssetUrl(preparedConnection.value.httpBaseUrl, result.value, now)
        : null,
    );
  }, [preparedConnection, resources, results]);
  return { urls, refresh };
}

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const result = useAssetUrlState(environmentId, resource);
  if (result._tag !== "Success") {
    return null;
  }
  return result.url;
}

export function useAssetUrls(
  environmentId: EnvironmentId | null,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  return useAssetUrlsState(environmentId, resources).urls;
}
