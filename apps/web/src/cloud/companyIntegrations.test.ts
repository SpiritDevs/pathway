import { describe, expect, it, vi } from "vite-plus/test";

import { withCompanyIntegrationsQueryTimeout } from "./companyIntegrations";

describe("withCompanyIntegrationsQueryTimeout", () => {
  it("returns a completed Convex query", async () => {
    await expect(
      withCompanyIntegrationsQueryTimeout(Promise.resolve(["integration"]), "Loading integrations"),
    ).resolves.toEqual(["integration"]);
  });

  it("turns a hung Convex query into an actionable error", async () => {
    vi.useFakeTimers();
    try {
      const request = withCompanyIntegrationsQueryTimeout(
        new Promise<never>(() => {}),
        "Loading integrations",
        10_000,
      );
      const assertion = expect(request).rejects.toThrow(
        "Loading integrations timed out. Check your cloud connection, then try again.",
      );

      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
