import { describe, expect, it } from "vite-plus/test";
import { parseAssetReference } from "./assetReference.logic";
describe("durable asset references", () => {
  it("keeps company scope independent of the current environment", () => {
    expect(parseAssetReference("pathway-asset:company-1/asset_2")).toEqual({
      companyId: "company-1",
      assetId: "asset_2",
    });
  });
  it.each([
    undefined,
    "",
    "/Users/corey/movie.mp4",
    "file:///movie.mp4",
    "https://example.com/movie.mp4",
    "pathway-asset:company/../private",
    "pathway-asset:company/asset?token=secret",
    "pathway-asset:/asset",
  ])("does not mistake %s for a durable reference", (value) => {
    expect(parseAssetReference(value)).toBeNull();
  });
});
