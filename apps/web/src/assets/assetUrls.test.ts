import type { AssetCreateUrlResult } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAssetUrl, resolveCurrentAssetUrl } from "./assetUrls";

const NOW = 1_000_000;

function result(expiresAt: number): AssetCreateUrlResult {
  return {
    relativeUrl: "/api/assets/signed/image.png",
    expiresAt,
  };
}

describe("resolveAssetUrl", () => {
  it("resolves an environment-relative asset URL", () => {
    expect(
      resolveAssetUrl("https://environment.example/base/", "/api/assets/signed-token/favicon.png"),
    ).toBe("https://environment.example/api/assets/signed-token/favicon.png");
  });

  it("rejects an invalid environment base URL", () => {
    expect(resolveAssetUrl("not a URL", "/api/assets/signed-token/favicon.png")).toBeNull();
  });
});

describe("resolveCurrentAssetUrl", () => {
  it("resolves a freshly issued URL against the active environment", () => {
    expect(
      resolveCurrentAssetUrl("https://environment.test/base", result(NOW + 3_600_000), NOW),
    ).toBe("https://environment.test/api/assets/signed/image.png");
  });

  it("refuses expired URLs and URLs inside the request safety window", () => {
    expect(resolveCurrentAssetUrl("https://environment.test", result(NOW - 1), NOW)).toBeNull();
    expect(
      resolveCurrentAssetUrl("https://environment.test", result(NOW + 60_000), NOW),
    ).toBeNull();
  });
});
