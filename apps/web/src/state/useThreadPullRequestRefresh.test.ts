import { describe, expect, it } from "vite-plus/test";

import { shouldRefreshOnReturn } from "./useThreadPullRequestRefresh";

describe("shouldRefreshOnReturn", () => {
  it("refreshes a pull request once per interval across thread switches", () => {
    const key = JSON.stringify({ environmentId: "env", input: { number: 1 } });
    expect(shouldRefreshOnReturn(key, 1_000)).toBe(true);
    // Switching away and back, or several views mounting the same pull request.
    expect(shouldRefreshOnReturn(key, 2_000)).toBe(false);
    expect(shouldRefreshOnReturn(key, 30_999)).toBe(false);
    expect(shouldRefreshOnReturn(key, 31_000)).toBe(true);
  });

  it("tracks each pull request separately", () => {
    const first = JSON.stringify({ environmentId: "env", input: { number: 2 } });
    const second = JSON.stringify({ environmentId: "env", input: { number: 3 } });
    expect(shouldRefreshOnReturn(first, 1_000)).toBe(true);
    expect(shouldRefreshOnReturn(second, 1_000)).toBe(true);
  });
});
