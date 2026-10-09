import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_BROWSER_AGENT_PERMISSIONS,
  DEFAULT_BROWSER_SITE_PERMISSION_SETTINGS,
  browserSitePatternMatches,
  normalizeBrowserSitePattern,
  resolveBrowserAgentAccess,
  resolveBrowserSitePermission,
  setBrowserAgentSitePolicy,
  setBrowserSitePermission,
} from "./browserSettings.ts";

describe("normalizeBrowserSitePattern", () => {
  it("accepts origins, wildcards, and bare hosts", () => {
    expect(normalizeBrowserSitePattern("example.com")).toBe("https://example.com");
    expect(normalizeBrowserSitePattern(" https://Example.com/path ")).toBe("https://example.com");
    expect(normalizeBrowserSitePattern("http://*.example.com:8080")).toBe(
      "http://*.example.com:8080",
    );
  });

  it("rejects what is not a web site", () => {
    expect(normalizeBrowserSitePattern("")).toBeNull();
    expect(normalizeBrowserSitePattern("file:///etc/hosts")).toBeNull();
    expect(normalizeBrowserSitePattern("https://user:pass@example.com")).toBeNull();
  });
});

describe("browserSitePatternMatches", () => {
  it("matches exact origins and subdomain wildcards", () => {
    expect(browserSitePatternMatches("https://example.com", "https://example.com")).toBe(true);
    expect(browserSitePatternMatches("https://example.com", "http://example.com")).toBe(false);
    expect(browserSitePatternMatches("https://*.example.com", "https://a.b.example.com")).toBe(
      true,
    );
    expect(browserSitePatternMatches("https://*.example.com", "https://example.com")).toBe(true);
    expect(browserSitePatternMatches("https://*.example.com", "https://badexample.com")).toBe(
      false,
    );
  });
});

describe("resolveBrowserAgentAccess", () => {
  it("prefers the most specific pattern per column, then the defaults", () => {
    let permissions = setBrowserAgentSitePolicy(
      DEFAULT_BROWSER_AGENT_PERMISSIONS,
      "https://*.example.com",
      { browse: "block", download: "block" },
    );
    permissions = setBrowserAgentSitePolicy(permissions, "https://app.example.com", {
      browse: "approval",
    });
    expect(resolveBrowserAgentAccess(permissions, "https://app.example.com")).toEqual({
      browse: "approval",
      download: "block",
      cdp: "block",
    });
    expect(resolveBrowserAgentAccess(permissions, "https://other.test")).toEqual(
      DEFAULT_BROWSER_AGENT_PERMISSIONS.defaults,
    );
  });

  it("removes a site when its access is emptied", () => {
    const permissions = setBrowserAgentSitePolicy(
      DEFAULT_BROWSER_AGENT_PERMISSIONS,
      "https://example.com",
      { browse: "block" },
    );
    expect(setBrowserAgentSitePolicy(permissions, "https://example.com", null).sites).toEqual([]);
  });
});

describe("site permissions", () => {
  it("lets a site's choice override the default, and clears it again", () => {
    const origin = "https://meet.example.com";
    const allowed = setBrowserSitePermission(
      DEFAULT_BROWSER_SITE_PERMISSION_SETTINGS,
      origin,
      "camera",
      "allow",
    );
    expect(resolveBrowserSitePermission(allowed, origin, "camera")).toBe("allow");
    expect(resolveBrowserSitePermission(allowed, "https://other.test", "camera")).toBe(
      resolveBrowserSitePermission(DEFAULT_BROWSER_SITE_PERMISSION_SETTINGS, null, "camera"),
    );
    expect(setBrowserSitePermission(allowed, origin, "camera", null).sites).toEqual([]);
  });
});
