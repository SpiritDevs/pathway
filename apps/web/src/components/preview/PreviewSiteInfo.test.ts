import { describe, expect, it } from "vite-plus/test";

import { siteConnection } from "./PreviewSiteInfo";

describe("siteConnection", () => {
  it("calls https secure, plain http not secure, and localhost a local server", () => {
    expect(siteConnection(new URL("https://www.google.com/")).title).toBe("Connection is secure");
    expect(siteConnection(new URL("http://example.com/")).title).toBe("Connection is not secure");
    expect(siteConnection(new URL("http://localhost:3000/")).title).toBe("Local server");
  });
});
