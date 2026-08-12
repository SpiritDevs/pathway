import { describe, expect, it } from "vite-plus/test";

import { deriveMailSlug, MAIL_SLUG_MAX_LENGTH } from "./mailSlug.ts";

describe("deriveMailSlug", () => {
  it("derives a lowercase DNS label from the directory basename", () => {
    expect(deriveMailSlug("~/code/My-App", [])).toBe("my-app");
    expect(deriveMailSlug("/work/Checkout & Payments/", [])).toBe("checkout-payments");
    expect(deriveMailSlug("C:\\code\\My App", [])).toBe("my-app");
  });

  it("uses -2 for the first collision and keeps incrementing", () => {
    expect(deriveMailSlug("/work/My-App", ["my-app"])).toBe("my-app-2");
    expect(deriveMailSlug("/work/My-App", ["MY-APP", "my-app-2"])).toBe("my-app-3");
  });

  it("falls back for a basename with no ASCII letters or digits", () => {
    expect(deriveMailSlug("/work/---", [])).toBe("project");
    expect(deriveMailSlug("/work/---", ["project"])).toBe("project-2");
  });

  it("keeps the base and collision variants within a DNS label", () => {
    const directory = `/work/${"a".repeat(MAIL_SLUG_MAX_LENGTH + 20)}`;
    const base = deriveMailSlug(directory, []);
    const collision = deriveMailSlug(directory, [base]);

    expect(base).toHaveLength(MAIL_SLUG_MAX_LENGTH);
    expect(collision).toHaveLength(MAIL_SLUG_MAX_LENGTH);
    expect(collision.endsWith("-2")).toBe(true);
  });
});
