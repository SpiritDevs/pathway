import { describe, expect, it } from "vite-plus/test";

import { browserLinkTarget } from "./browserLinkTarget";

const settings = { browserWebLinkTarget: "external", browserLocalLinkTarget: "browser" } as const;

describe("browserLinkTarget", () => {
  it("uses the local target for loopback addresses", () => {
    expect(browserLinkTarget("http://localhost:3000/", settings)).toBe("browser");
    expect(browserLinkTarget("http://127.0.0.1:5173/app", settings)).toBe("browser");
  });

  it("uses the web target for everything else", () => {
    expect(browserLinkTarget("https://example.com/", settings)).toBe("external");
    expect(
      browserLinkTarget("https://example.com/", { ...settings, browserWebLinkTarget: "browser" }),
    ).toBe("browser");
  });
});
