import { describe, expect, it, vi } from "vite-plus/test";
import type { ConvexAuthTokenFetcher } from "./syncTransport";
import { createConvexClientPool } from "./convexClientPool";

const scope = { url: "https://test.convex.cloud", accountId: "owner", sessionId: "session" };
function pool() {
  const create = vi.fn(() => ({
    setAuth: vi.fn<(fetch: ConvexAuthTokenFetcher) => void>(),
    close: vi.fn(async () => {}),
  }));
  return { create, acquire: createConvexClientPool(create) };
}

describe("shared authenticated Convex connections", () => {
  it("retains one socket for concurrent consumers, including identical token fetchers", async () => {
    const { acquire, create } = pool();
    const fetch = vi.fn(async () => "token");
    const first = acquire(scope, fetch);
    const second = acquire(scope, fetch);
    expect(create).toHaveBeenCalledTimes(1);
    expect(first.client).toBe(second.client);
    expect(first.client.setAuth).toHaveBeenCalledTimes(1);
    first.release();
    first.release();
    expect(second.client.close).not.toHaveBeenCalled();
    const auth = second.client.setAuth.mock.calls[0]![0];
    await expect(auth({ forceRefreshToken: true })).resolves.toBe("token");
    second.release();
    expect(second.client.close).toHaveBeenCalledTimes(1);
    await expect(auth({ forceRefreshToken: true })).resolves.toBeNull();
    const next = acquire(scope, fetch);
    expect(next.client).not.toBe(first.client);
    next.release();
  });

  it("isolates accounts, sessions and deployments", () => {
    const { acquire, create } = pool();
    const leases = [
      scope,
      { ...scope, accountId: "another" },
      { ...scope, sessionId: "new-session" },
      { ...scope, url: "https://other.convex.cloud" },
    ].map((value) => acquire(value, async () => "token"));
    expect(create).toHaveBeenCalledTimes(4);
    for (const lease of leases) lease.release();
  });

  it("refreshes through a remaining consumer after the original owner unmounts", async () => {
    const { acquire } = pool();
    const first = acquire(scope, async () => "old");
    let token = "fresh";
    const second = acquire(scope, async () => token);
    first.release();
    const auth = second.client.setAuth.mock.calls[0]![0];
    await expect(auth({ forceRefreshToken: true })).resolves.toBe("fresh");
    token = "refreshed";
    await expect(auth({ forceRefreshToken: true })).resolves.toBe("refreshed");
    second.release();
  });
});
