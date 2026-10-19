import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
} from "./managedAuth";
import { makeClerkConvexTokenFetcher, managedRelayClerkTokenFetcher } from "./syncTransportAuth";

vi.mock("@clerk/react", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

afterEach(() => {
  deactivateManagedRelayAuthentication();
  vi.restoreAllMocks();
});

/** The fetchers report a refused token before answering, and a test asserts on that report. */
const silenceWarnings = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("makeClerkConvexTokenFetcher", () => {
  it("mints from the convex template, skipping the cache only on a forced refresh", async () => {
    const options: Array<{ readonly template: string; readonly skipCache: boolean }> = [];
    const fetchToken = makeClerkConvexTokenFetcher(async (given) => {
      options.push(given);
      return "token";
    });

    expect(await fetchToken({ forceRefreshToken: false })).toBe("token");
    expect(await fetchToken({ forceRefreshToken: true })).toBe("token");
    expect(options).toEqual([
      { template: "convex", skipCache: false },
      { template: "convex", skipCache: true },
    ]);
  });

  // Convex pauses the socket around the await on this fetcher and resumes it only after the await
  // returns, so a rejection wedges the socket for the life of the tab: no query settles and no
  // subscription — not even its onError — ever fires again. Clerk rejects for two ordinary
  // reasons: an offline tab, and a missing `convex` JWT template.
  it("answers null when Clerk rejects instead of rejecting with it", async () => {
    const warn = silenceWarnings();
    const fetchToken = makeClerkConvexTokenFetcher(() =>
      Promise.reject(new Error("ClerkOfflineError: browser is offline")),
    );

    await expect(fetchToken({ forceRefreshToken: false })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("managedRelayClerkTokenFetcher", () => {
  it("reads the relay token the auth provider registered", async () => {
    activateManagedRelayAuthentication("account-1", async () => "relay-token");

    expect(await managedRelayClerkTokenFetcher({ forceRefreshToken: false })).toBe("relay-token");
  });

  it("answers null when the relay token source rejects", async () => {
    const warn = silenceWarnings();
    activateManagedRelayAuthentication("account-1", () =>
      Promise.reject(new Error("PATHWAY_CLERK_JWT_TEMPLATE is not configured.")),
    );

    await expect(managedRelayClerkTokenFetcher({ forceRefreshToken: false })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
