import type { Asset } from "@spiritdevs/contracts/assets";
import { useEffect, useState } from "react";
import { assetFunctions, useAssetClient } from "../../cloud/assetClient";
import { AssetGallery, AssetMedia } from "./AssetMedia";

export { parseAssetReference } from "./assetReference.logic";

export function AssetReference({
  companyId,
  assetId,
  threadId,
  environmentId,
}: {
  companyId: string;
  assetId: string;
  threadId?: string;
  environmentId?: string;
}) {
  const client = useAssetClient();
  const [asset, setAsset] = useState<Asset | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [gallery, setGallery] = useState(false);
  const [threadAssets, setThreadAssets] = useState<Asset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  useEffect(() => {
    if (!gallery || !client || !threadId) return;
    return client.onUpdate(
      assetFunctions.list,
      { companyId, threadId, ...(environmentId ? { environmentId } : {}), limit: 100 },
      (page) => {
        setThreadAssets(page.items.toSorted((a, b) => a.createdAt - b.createdAt));
        setNextCursor(page.nextCursor);
      },
      (reason) => setError(reason.message),
    );
  }, [gallery, client, companyId, threadId, environmentId]);
  useEffect(() => {
    if (!client) return;
    setAsset(undefined);
    setError(null);
    return client.onUpdate(assetFunctions.get, { companyId, assetId }, setAsset, (reason) =>
      setError(reason.message),
    );
  }, [client, companyId, assetId]);
  if (error)
    return (
      <span role="alert" className="block rounded-lg border p-3 text-sm">
        Asset unavailable: {error}
      </span>
    );
  if (!client)
    return (
      <span className="block rounded-lg border p-3 text-sm">
        Connect to Pathway Cloud to view this asset.
      </span>
    );
  if (asset === undefined)
    return (
      <span role="status" className="block rounded-lg border bg-muted/20 p-3 text-sm">
        Loading asset…
      </span>
    );
  if (asset === null)
    return (
      <span className="block rounded-lg border p-3 text-sm">Asset unavailable or deleted</span>
    );
  return (
    <>
      <AssetMedia asset={asset} client={client} onGallery={() => setGallery(true)} />
      {gallery && (
        <AssetGallery
          assets={threadAssets.length ? threadAssets : [asset]}
          selectedId={asset.id}
          client={client}
          {...(nextCursor && threadId
            ? {
                onLoadMore: async () => {
                  const page = await client.query(assetFunctions.list, {
                    companyId,
                    threadId,
                    ...(environmentId ? { environmentId } : {}),
                    cursor: nextCursor,
                    limit: 100,
                  });
                  setThreadAssets((current) =>
                    [...current, ...page.items].toSorted((a, b) => a.createdAt - b.createdAt),
                  );
                  setNextCursor(page.nextCursor);
                },
              }
            : {})}
          onClose={() => setGallery(false)}
        />
      )}
    </>
  );
}
