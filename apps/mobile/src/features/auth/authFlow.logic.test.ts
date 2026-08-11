import { describe, expect, it } from "vite-plus/test";

import {
  canSubmitPasswordReset,
  canSubmitRegistration,
  canSubmitSignIn,
  isCompleteVerificationCode,
  isLikelyEmailAddress,
  normalizeVerificationCode,
  resolveAuthFlowBackStep,
  resolveResendCooldownSeconds,
  VERIFICATION_RESEND_COOLDOWN_SECONDS,
} from "./authFlow.logic";

describe("resolveAuthFlowBackStep", () => {
  it("has no back step at the root", () => {
    expect(resolveAuthFlowBackStep({ kind: "sign-in" })).toEqual(null);
  });

  it("returns to sign-in from register and forgot-password", () => {
    expect(resolveAuthFlowBackStep({ kind: "register" })).toEqual({ kind: "sign-in" });
    expect(resolveAuthFlowBackStep({ kind: "forgot-password", emailAddress: "a@b.co" })).toEqual({
      kind: "sign-in",
    });
  });

  it("returns to register from verification, because no account exists yet", () => {
    expect(resolveAuthFlowBackStep({ kind: "verify-email", emailAddress: "a@b.co" })).toEqual({
      kind: "register",
    });
  });
});

describe("isLikelyEmailAddress", () => {
  it("accepts ordinary addresses", () => {
    expect(isLikelyEmailAddress("someone@example.com")).toEqual(true);
    expect(isLikelyEmailAddress("  someone+tag@example.co.uk  ")).toEqual(true);
  });

  it("rejects empty, spaced, and malformed input", () => {
    expect(isLikelyEmailAddress("")).toEqual(false);
    expect(isLikelyEmailAddress("someone")).toEqual(false);
    expect(isLikelyEmailAddress("@example.com")).toEqual(false);
    expect(isLikelyEmailAddress("someone@")).toEqual(false);
    expect(isLikelyEmailAddress("some one@example.com")).toEqual(false);
    expect(isLikelyEmailAddress("a@b@c.com")).toEqual(false);
    expect(isLikelyEmailAddress("someone@.com")).toEqual(false);
    expect(isLikelyEmailAddress("someone@example.")).toEqual(false);
  });
});

describe("normalizeVerificationCode", () => {
  it("keeps digits only and clamps to six", () => {
    expect(normalizeVerificationCode("123 456")).toEqual("123456");
    expect(normalizeVerificationCode("12-34-56-78")).toEqual("123456");
    expect(normalizeVerificationCode("abc")).toEqual("");
  });

  it("reports completeness off the normalized value", () => {
    expect(isCompleteVerificationCode("123 456")).toEqual(true);
    expect(isCompleteVerificationCode("12345")).toEqual(false);
  });
});

describe("submission guards", () => {
  it("requires an email and any password to sign in", () => {
    expect(canSubmitSignIn({ emailAddress: "a@b.co", password: "x", isSubmitting: false })).toEqual(
      true,
    );
    expect(canSubmitSignIn({ emailAddress: "a@b.co", password: "", isSubmitting: false })).toEqual(
      false,
    );
    expect(canSubmitSignIn({ emailAddress: "a", password: "x", isSubmitting: false })).toEqual(
      false,
    );
    expect(canSubmitSignIn({ emailAddress: "a@b.co", password: "x", isSubmitting: true })).toEqual(
      false,
    );
  });

  it("requires eight characters to register", () => {
    expect(
      canSubmitRegistration({
        emailAddress: "a@b.co",
        password: "1234567",
        isSubmitting: false,
      }),
    ).toEqual(false);
    expect(
      canSubmitRegistration({
        emailAddress: "a@b.co",
        password: "12345678",
        isSubmitting: false,
      }),
    ).toEqual(true);
  });

  it("requires a full code and a valid new password to reset", () => {
    expect(
      canSubmitPasswordReset({ code: "12345", password: "12345678", isSubmitting: false }),
    ).toEqual(false);
    expect(
      canSubmitPasswordReset({ code: "123456", password: "short", isSubmitting: false }),
    ).toEqual(false);
    expect(
      canSubmitPasswordReset({ code: "123456", password: "12345678", isSubmitting: false }),
    ).toEqual(true);
  });
});

describe("resolveResendCooldownSeconds", () => {
  it("is live before anything has been sent", () => {
    expect(resolveResendCooldownSeconds({ sentAtMs: null, nowMs: 1_000 })).toEqual(0);
  });

  it("counts down from the full cooldown", () => {
    expect(resolveResendCooldownSeconds({ sentAtMs: 10_000, nowMs: 10_000 })).toEqual(
      VERIFICATION_RESEND_COOLDOWN_SECONDS,
    );
    expect(resolveResendCooldownSeconds({ sentAtMs: 10_000, nowMs: 19_500 })).toEqual(21);
  });

  it("never reports a negative cooldown", () => {
    expect(resolveResendCooldownSeconds({ sentAtMs: 10_000, nowMs: 999_000 })).toEqual(0);
  });
});
