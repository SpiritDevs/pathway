import { describe, expect, it } from "vite-plus/test";

import { threadIsVisibleAt } from "./threadLocation.ts";

describe("threadIsVisibleAt", () => {
  it("keeps legacy threads in the agent view", () => {
    expect(threadIsVisibleAt({}, "agents")).toBe(true);
    expect(threadIsVisibleAt({}, "issues")).toBe(false);
  });

  it("supports threads that are visible in one or several views", () => {
    expect(threadIsVisibleAt({ locations: ["issues"] }, "agents")).toBe(false);
    expect(threadIsVisibleAt({ locations: ["issues"] }, "issues")).toBe(true);
    expect(threadIsVisibleAt({ locations: ["agents", "issues"] }, "agents")).toBe(true);
    expect(threadIsVisibleAt({ locations: ["agents", "issues"] }, "issues")).toBe(true);
  });
});
