import { describe, expect, it } from "vite-plus/test";

import { clerkErrorMessage } from "./clerkErrorMessage";

describe("clerkErrorMessage", () => {
  it("maps a known Clerk error code to product copy", () => {
    expect(
      clerkErrorMessage({ errors: [{ code: "form_password_incorrect" }] }, "fallback"),
    ).toEqual("That password is incorrect.");
  });

  it("prefers the long message for an unmapped code", () => {
    expect(
      clerkErrorMessage(
        {
          errors: [
            { code: "form_param_unknown", message: "short", longMessage: "the long message" },
          ],
        },
        "fallback",
      ),
    ).toEqual("the long message");
  });

  it("falls back to the short message when there is no long message", () => {
    expect(clerkErrorMessage({ errors: [{ code: "nope", message: "short" }] }, "fallback")).toEqual(
      "short",
    );
  });

  it("returns the caller fallback for non-Clerk failures", () => {
    expect(clerkErrorMessage(new Error("network down"), "fallback")).toEqual("fallback");
    expect(clerkErrorMessage(null, "fallback")).toEqual("fallback");
    expect(clerkErrorMessage({ errors: [] }, "fallback")).toEqual("fallback");
    expect(clerkErrorMessage({ errors: "nope" }, "fallback")).toEqual("fallback");
  });
});
