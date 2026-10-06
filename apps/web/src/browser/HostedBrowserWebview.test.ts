import { describe, expect, it } from "vite-plus/test";

import { webviewSrc } from "./HostedBrowserWebview";

describe("webviewSrc", () => {
  it("restores websites", () => {
    expect(webviewSrc("https://example.com/path")).toBe("https://example.com/path");
  });

  it("opens blank when there is nothing to restore", () => {
    expect(webviewSrc(null)).toBe("about:blank");
    expect(webviewSrc("")).toBe("about:blank");
  });

  it("never loads a browser page taken from server state", () => {
    expect(webviewSrc("chrome://settings/content/siteDetails?site=https%3A%2F%2Fexample.com")).toBe(
      "about:blank",
    );
    expect(webviewSrc("chrome://settings/clearBrowserData")).toBe("about:blank");
  });
});
