import { useAuth } from "@clerk/react";
import type { Asset, AssetContext, AssetKind, AssetPage } from "@spiritdevs/contracts/assets";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveCloudSyncConvexUrl } from "./publicConfig";
import { makeClerkConvexTokenFetcher } from "./syncTransportAuth";

export type AssetListInput = {
  companyId: string;
  threadId?: string;
  environmentId?: string;
  search?: string;
  kind?: AssetKind;
  trashed?: boolean;
  cursor?: string;
  limit?: number;
  uploaderId?: string;
  createdAfter?: number;
  sort?: "newest" | "name" | "size";
};
const query = <A extends Record<string, unknown>, R>(name: string) =>
  makeFunctionReference<"query", A, R>(`assets:${name}`);
const mutation = <A extends Record<string, unknown>, R>(name: string) =>
  makeFunctionReference<"mutation", A, R>(`assets:${name}`);
const action = <A extends Record<string, unknown>, R>(name: string) =>
  makeFunctionReference<"action", A, R>(`assets:${name}`);
type Identity = { companyId: string; assetId: string };
export const assetFunctions = {
  list: query<AssetListInput, AssetPage>("list"),
  get: query<Identity, Asset | null>("get"),
  resolveLegacy: query<
    { companyId: string; source: "queue" | "tasks"; legacyId: string },
    Asset | null
  >("resolveLegacy"),
  threadCounts: query<
    { companyId: string },
    { threadId: string; environmentId?: string; count: number }[]
  >("threadCounts"),
  prepareUpload: action<
    {
      companyId: string;
      clientRequestId: string;
      fileName: string;
      mimeType: string;
      byteSize: number;
      checksum: string;
      context?: AssetContext;
    },
    { assetId: string; uploadUrl: string | null; state: string }
  >("prepareUpload"),
  finalizeUpload: action<Identity, Asset>("finalizeUpload"),
  resolve: mutation<
    Identity & { representation?: "original" | "preview" | "poster" },
    { url: string; expiresAt: number }
  >("resolve"),
  configureQuota: mutation<{ companyId: string; maxBytes: number; maxFileBytes: number }, unknown>(
    "configureQuota",
  ),
  retryProcessing: mutation<Identity, unknown>("retryProcessing"),
  rename: mutation<Identity & { name: string }, unknown>("rename"),
  trash: mutation<Identity, unknown>("trash"),
  restore: mutation<Identity, unknown>("restore"),
  keep: mutation<Identity & { keep: boolean }, unknown>("keep"),
  attach: mutation<Identity & { context: AssetContext; confirmBroaderAccess: boolean }, unknown>(
    "attach",
  ),
  detach: mutation<Identity & { context: AssetContext }, unknown>("detach"),
  share: mutation<
    Identity & { expiresInDays?: number },
    { shareId: string; url: string; expiresAt: number }
  >("share"),
  revokeShare: mutation<Identity & { shareId: string }, unknown>("revokeShare"),
};

export async function uploadAsset(
  client: ConvexClient,
  input: { companyId: string; file: File; clientRequestId: string; context?: AssetContext },
  onProgress: (state: string) => void,
) {
  onProgress("Preparing upload");
  const checksum = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await input.file.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const prepared = await client.action(assetFunctions.prepareUpload, {
    companyId: input.companyId,
    clientRequestId: input.clientRequestId,
    fileName: input.file.name,
    mimeType: input.file.type || "application/octet-stream",
    byteSize: input.file.size,
    checksum,
    ...(input.context ? { context: input.context } : {}),
  });
  if (prepared.uploadUrl) {
    onProgress("Uploading");
    const body = new FormData();
    body.append("file", input.file, input.file.name);
    const response = await fetch(prepared.uploadUrl, {
      method: "PUT",
      body,
      headers: { Range: "bytes=0-", "x-uploadthing-version": "7.7.4" },
    });
    if (!response.ok)
      throw new Error(`Upload failed (${response.status}). Your file is still available to retry.`);
  }
  onProgress("Verifying upload");
  return client.action(assetFunctions.finalizeUpload, {
    companyId: input.companyId,
    assetId: prepared.assetId,
  });
}

const clientPool = new Map<string, { client: ConvexClient; users: number }>();
/** Share one authenticated connection across the gallery, transcript and library. */
export function useAssetClient() {
  const { getToken, isSignedIn, userId } = useAuth();
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const url = resolveCloudSyncConvexUrl();
  const poolKey = `${url}:${userId}`;
  const entry = useMemo(() => {
    if (!isSignedIn || !url) return null;
    let value = clientPool.get(poolKey);
    if (!value) {
      const client = new ConvexClient(url);
      client.setAuth((args) => makeClerkConvexTokenFetcher(tokenRef.current)(args));
      value = { client, users: 0 };
      clientPool.set(poolKey, value);
    }
    return value;
  }, [isSignedIn, url, poolKey]);
  useEffect(() => {
    if (!entry || !url) return;
    entry.users++;
    return () => {
      entry.users--;
      // A queued cleanup lets Strict Mode's effect replay retain the same connection.
      queueMicrotask(() => {
        if (entry.users === 0 && clientPool.get(poolKey) === entry) {
          clientPool.delete(poolKey);
          void entry.client.close();
        }
      });
    };
  }, [entry, url, poolKey]);
  return entry?.client ?? null;
}

export function useThreadAssetCounts(companyId: string | null, companyIds: readonly string[] = []) {
  const client = useAssetClient();
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const scopeKey = JSON.stringify(companyId ? [companyId] : companyIds);
  useEffect(() => {
    setCounts(new Map());
    if (!client) return;
    const scoped: string[] = JSON.parse(scopeKey);
    const byCompany = new Map<string, Map<string, number>>();
    const subscriptions = scoped.map((id) =>
      client.onUpdate(
        assetFunctions.threadCounts,
        { companyId: id },
        (values) => {
          byCompany.set(
            id,
            new Map(
              values.map((value) => [`${value.environmentId}:${value.threadId}`, value.count]),
            ),
          );
          setCounts(new Map([...byCompany.values()].flatMap((value) => [...value])));
        },
        () => {
          byCompany.delete(id);
          setCounts(new Map([...byCompany.values()].flatMap((value) => [...value])));
        },
      ),
    );
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [client, scopeKey]);
  return counts;
}
