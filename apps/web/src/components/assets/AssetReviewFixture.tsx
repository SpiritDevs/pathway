/** Development-only sample data for visual review. Never authenticates or writes a backend. */
import type { Asset, AssetPage } from "@spiritdevs/contracts/assets";
import type { ConvexClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { useMemo, useState } from "react";
import { AssetLibraryContent } from "./AssetLibrary";
import { AssetGallery, AssetMedia } from "./AssetMedia";

const artwork = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><defs><linearGradient id="g"><stop stop-color="#e9eefe"/><stop offset="1" stop-color="#d3f6ee"/></linearGradient></defs><rect width="1200" height="675" fill="url(#g)"/><rect x="120" y="90" width="960" height="495" rx="35" fill="white"/><text x="180" y="190" fill="#122438" font-size="35" font-family="system-ui">Your next idea, ready to share.</text><rect x="180" y="250" width="380" height="245" rx="22" fill="#dce8ff"/><rect x="600" y="250" width="410" height="60" rx="15" fill="#eef1f5"/><rect x="600" y="335" width="310" height="35" rx="12" fill="#eef1f5"/><rect x="600" y="395" width="350" height="35" rx="12" fill="#eef1f5"/></svg>')}`;
function sample(id: string, name: string, kind: Asset["kind"], mimeType: string): Asset {
  return {
    id,
    companyId: "review-company",
    name,
    kind,
    mimeType,
    byteSize: 2400000,
    state: "ready",
    previewState: "ready",
    originalReady: true,
    createdAt: 1789200000000,
    updatedAt: 1789200000000,
    uploaderId: "Corey (sample)",
    keepInLibrary: false,
    trashedAt: null,
    error: null,
    contexts: [{ kind: "thread", id: "Design review", environmentId: "review-mac" }],
    shares: [],
    permissions: { canManage: true, canShare: true },
    reference: { type: "asset", companyId: "review-company", assetId: id },
  };
}
export function makeAssetReviewClient() {
  let assets = [
    sample("image-review", "Conversation layout.png", "image", "image/png"),
    sample("video-review", "Compact composer review.mp4", "video", "video/mp4"),
    {
      ...sample("document-review", "Design notes.pdf", "document", "application/pdf"),
      previewState: "unsupported" as const,
    },
    {
      ...sample("preparing-review", "iPad walkthrough.mov", "video", "video/quicktime"),
      state: "preparing" as const,
      previewState: "pending" as const,
    },
  ];
  const listeners = new Set<() => void>();
  const page = (args: Record<string, unknown>): AssetPage => ({
    items: assets.filter(
      (asset) =>
        (asset.state === "trashed") === Boolean(args.trashed) &&
        (!args.search || asset.name.toLowerCase().includes(String(args.search).toLowerCase())) &&
        (!args.kind || asset.kind === args.kind),
    ),
    nextCursor: null,
    usage: {
      usedBytes: 9600000,
      reservedBytes: 0,
      maxBytes: 10 * 1024 ** 3,
      maxFileBytes: 250 * 1024 ** 2,
    },
  });
  const fixture = {
    query: async (_reference: unknown, args: Record<string, unknown>) => page(args),
    onUpdate: (
      _reference: unknown,
      args: Record<string, unknown>,
      update: (value: AssetPage) => void,
    ) => {
      const notify = () => update(page(args));
      listeners.add(notify);
      queueMicrotask(notify);
      return () => listeners.delete(notify);
    },
    mutation: async (reference: FunctionReference<"mutation">, args: Record<string, unknown>) => {
      const name = getFunctionName(reference).split(":")[1];
      if (name === "resolve")
        return {
          url:
            args.assetId === "video-review" && args.representation !== "poster"
              ? "/asset-review-sample.mp4"
              : artwork,
          expiresAt: Date.now() + 600000,
        };
      assets = assets.map((asset) =>
        asset.id !== args.assetId
          ? asset
          : name === "rename"
            ? { ...asset, name: String(args.name) }
            : name === "trash"
              ? {
                  ...asset,
                  state: "trashed",
                  trashedAt: Date.now(),
                  shares: asset.shares.map((share) => ({ ...share, revokedAt: Date.now() })),
                }
              : name === "restore"
                ? { ...asset, state: "ready", trashedAt: null }
                : name === "keep"
                  ? { ...asset, keepInLibrary: Boolean(args.keep) }
                  : name === "share"
                    ? {
                        ...asset,
                        shares: [
                          ...asset.shares,
                          {
                            id: "sample-share",
                            expiresAt: Date.now() + Number(args.expiresInDays ?? 7) * 86400000,
                            revokedAt: null,
                          },
                        ],
                      }
                    : name === "revokeShare"
                      ? {
                          ...asset,
                          shares: asset.shares.map((share) =>
                            share.id === args.shareId ? { ...share, revokedAt: Date.now() } : share,
                          ),
                        }
                      : asset,
      );
      for (const notify of listeners) notify();
      if (name === "share")
        return {
          shareId: "sample-share",
          url: "https://example.com/sample-only",
          expiresAt: Date.now() + 604800000,
        };
      return null;
    },
    action: async () => {
      throw new Error("Sample review only. Uploads require the real authenticated Assets page.");
    },
  };
  return { client: fixture as unknown as ConvexClient, assets: () => assets };
}
export function AssetReviewFixture() {
  const fixture = useMemo(makeAssetReviewClient, []);
  const [gallery, setGallery] = useState<string | null>(null);
  const items = fixture.assets();
  return (
    <main className="mx-auto max-w-6xl space-y-8 p-8">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        UI review · Sample files only · No backend changes
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-label="Sample conversation">
          <h1 className="mb-4 text-xl font-semibold">Conversation assets</h1>
          <p className="mb-3 text-sm">Here is the updated layout and the walkthrough video.</p>
          {items.slice(0, 2).map((asset) => (
            <AssetMedia
              key={asset.id}
              asset={asset}
              client={fixture.client}
              onGallery={() => setGallery(asset.id)}
            />
          ))}
        </section>
        <AssetLibraryContent companyId="review-company" client={fixture.client} />
      </div>
      {gallery && (
        <AssetGallery
          assets={items}
          selectedId={gallery}
          client={fixture.client}
          onClose={() => setGallery(null)}
        />
      )}
    </main>
  );
}
