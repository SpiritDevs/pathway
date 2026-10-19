import { describe, expect, it, vi } from "vite-plus/test";

import {
  retainCompanyIntegrationsClient,
  type CompanyIntegrationsClient,
  withCompanyIntegrationsQueryTimeout,
} from "./companyIntegrations";

function fakeClient(close: () => Promise<void>): CompanyIntegrationsClient {
  return { close } as CompanyIntegrationsClient;
}

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

describe("retainCompanyIntegrationsClient", () => {
  it("does not close a client retained again during the Strict Mode lifecycle probe", async () => {
    const close = vi.fn(async () => undefined);
    const client = fakeClient(close);
    const releaseProbeMount = retainCompanyIntegrationsClient(client);

    releaseProbeMount();
    const releaseRealMount = retainCompanyIntegrationsClient(client);
    await Promise.resolve();

    expect(close).not.toHaveBeenCalled();

    releaseRealMount();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes an unmounted client after the current microtask", async () => {
    const close = vi.fn(async () => undefined);
    const release = retainCompanyIntegrationsClient(fakeClient(close));

    release();
    expect(close).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
