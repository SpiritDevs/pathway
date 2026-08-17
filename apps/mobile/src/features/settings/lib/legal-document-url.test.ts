import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://pathway.codes/legal",
    "https://pathway.codes/legal/",
    "https://pathway.codes/privacy-policy?source=app",
    "https://pathway.codes/terms-of-service#updates",
    "https://pathway.codes/security-policy",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://pathway.codes/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
