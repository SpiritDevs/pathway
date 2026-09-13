import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Asset } from "@spiritdevs/contracts/assets";
import type { ConvexClient } from "convex/browser";
import { AssetMedia, assetStatus } from "./AssetMedia";
const asset: Asset = {
  id: "review",
  companyId: "company",
  name: "Review.mp4",
  mimeType: "video/mp4",
  byteSize: 12000,
  kind: "video",
  state: "ready",
  previewState: "ready",
  originalReady: true,
  createdAt: 1,
  updatedAt: 1,
  uploaderId: "uploader",
  keepInLibrary: false,
  trashedAt: null,
  error: null,
  contexts: [],
  shares: [],
  permissions: { canManage: true, canShare: true },
  reference: { type: "asset", assetId: "review", companyId: "company" },
};
const client = {} as ConvexClient;
describe("asset media delivery states", () => {
  it("offers explicit video playback without preloading bytes or autoplay", () => {
    const html = renderToStaticMarkup(<AssetMedia asset={asset} client={client} />);
    expect(html).toContain("<video");
    expect(html).toContain('preload="none"');
    expect(html).not.toContain('controls=""');
    expect(html).not.toContain("autoplay");
    expect(html).toContain("Download Review.mp4");
  });
  it("keeps an uploaded original downloadable when preview preparation fails", () => {
    const failed = { ...asset, previewState: "failed" as const };
    expect(assetStatus(failed)).toContain("Original available");
    const html = renderToStaticMarkup(<AssetMedia asset={failed} client={client} />);
    expect(html).toContain("Download Review.mp4");
  });
  it.each(["trashed", "purged"] as const)(
    "shows history placeholders without media or download for %s",
    (state) => {
      const html = renderToStaticMarkup(<AssetMedia asset={{ ...asset, state }} client={client} />);
      expect(html).toContain("Asset deleted");
      expect(html).not.toContain("<video");
      expect(html).not.toContain("Download Review.mp4");
    },
  );
  it("does not label uploading or preparing assets as ready", () => {
    expect(assetStatus({ ...asset, state: "uploading", originalReady: false })).toBe("Uploading");
    expect(assetStatus({ ...asset, state: "preparing", previewState: "pending" })).toBe(
      "Preparing preview",
    );
  });
});
