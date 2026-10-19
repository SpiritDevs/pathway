import { describe, expect, it } from "vite-plus/test";

import { clerkErrorMessage } from "./clerkErrorMessage";

describe("clerkErrorMessage", () => {
  it("maps known Clerk error codes to friendly copy", () => {
    expect(clerkErrorMessage({ errors: [{ code: "form_password_incorrect" }] }, "fallback")).toBe(
      "That password is incorrect.",
    );
  });

  it("prefers the long message for unknown codes", () => {
    expect(
      clerkErrorMessage(
        { errors: [{ code: "brand_new_code", longMessage: "Long.", message: "Short." }] },
        "fallback",
      ),
    ).toBe("Long.");
  });

  it("falls back for non-Clerk failures", () => {
    expect(clerkErrorMessage(new Error("network down"), "fallback")).toBe("fallback");
    expect(clerkErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(clerkErrorMessage({ errors: [] }, "fallback")).toBe("fallback");
  });
});
