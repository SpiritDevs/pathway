import { describe, expect, it } from "vite-plus/test";

import { environmentCatalog, localEnvironmentCatalog } from "./catalog";

describe("environmentCatalog", () => {
  it("uses the app-level local catalog without a company-scoped projection", () => {
    expect(environmentCatalog).toBe(localEnvironmentCatalog);
  });
});
