import { describe, expect, it } from "vite-plus/test";

import {
  describeUnexpectedSignInStatus,
  initialSignInFormState,
  RESEND_COOLDOWN_SECONDS,
  resendCodeLabel,
  sanitizeVerificationCode,
  signInFormReducer,
  validateSubmission,
  type SignInFormEvent,
  type SignInFormState,
} from "./signInForm.logic";

function reduce(state: SignInFormState, ...events: readonly SignInFormEvent[]) {
  return events.reduce(signInFormReducer, state);
}

describe("sanitizeVerificationCode", () => {
  it("keeps only digits and caps the length at six", () => {
    expect(sanitizeVerificationCode("12-34 56")).toBe("123456");
    expect(sanitizeVerificationCode("abc123456789")).toBe("123456");
    expect(sanitizeVerificationCode("")).toBe("");
  });
});

describe("signInFormReducer", () => {
  it("records field edits and sanitizes the code as it is typed", () => {
    const state = reduce(
      initialSignInFormState,
      { field: "identifier", type: "fieldChanged", value: "ada@example.com" },
      { field: "password", type: "fieldChanged", value: "hunter22" },
      { field: "code", type: "fieldChanged", value: "1a2b3c4d" },
    );

    expect(state.identifier).toBe("ada@example.com");
    expect(state.password).toBe("hunter22");
    expect(state.code).toBe("1234");
  });

  it("keeps the email but drops the password when the reset flow starts", () => {
    const state = reduce(
      initialSignInFormState,
      { field: "identifier", type: "fieldChanged", value: "ada@example.com" },
      { field: "password", type: "fieldChanged", value: "wrong-password" },
      { message: "That password is incorrect.", type: "failed" },
      { type: "resetRequested" },
    );

    expect(state.step).toBe("reset-request");
    expect(state.identifier).toBe("ada@example.com");
    expect(state.password).toBe("");
    expect(state.error).toBeNull();
  });

  it("moves to the code screen and arms the cooldown once a code is sent", () => {
    const state = reduce(
      initialSignInFormState,
      { type: "resetRequested" },
      { type: "submitted" },
      { type: "codeSent" },
    );

    expect(state.step).toBe("reset-code");
    expect(state.pending).toBe(false);
    expect(state.resendCooldown).toBe(RESEND_COOLDOWN_SECONDS);
  });

  it("clears the stale code on a resend so the dead one cannot be submitted", () => {
    const state = reduce(
      initialSignInFormState,
      { type: "resetRequested" },
      { type: "codeSent" },
      { field: "code", type: "fieldChanged", value: "123456" },
      { type: "cooldownTicked" },
      { type: "codeSent" },
    );

    expect(state.code).toBe("");
    expect(state.resendCooldown).toBe(RESEND_COOLDOWN_SECONDS);
  });

  it("counts the cooldown down and stops at zero", () => {
    const armed = reduce(initialSignInFormState, { type: "resetRequested" }, { type: "codeSent" });
    const ticks: SignInFormEvent[] = Array.from(
      { length: RESEND_COOLDOWN_SECONDS + 5 },
      () => ({ type: "cooldownTicked" }) as const,
    );
    const drained = reduce(armed, ...ticks);

    expect(reduce(armed, { type: "cooldownTicked" }).resendCooldown).toBe(
      RESEND_COOLDOWN_SECONDS - 1,
    );
    expect(drained.resendCooldown).toBe(0);
  });

  it("returns the same object when ticking an idle cooldown", () => {
    expect(signInFormReducer(initialSignInFormState, { type: "cooldownTicked" })).toBe(
      initialSignInFormState,
    );
  });

  it("clears pending on failure and holds the message", () => {
    const state = reduce(
      initialSignInFormState,
      { type: "submitted" },
      { message: "No account exists with that email.", type: "failed" },
    );

    expect(state.pending).toBe(false);
    expect(state.error).toBe("No account exists with that email.");
  });

  it("drops the reset progress when the user backs out", () => {
    const state = reduce(
      initialSignInFormState,
      { field: "identifier", type: "fieldChanged", value: "ada@example.com" },
      { type: "resetRequested" },
      { type: "codeSent" },
      { field: "code", type: "fieldChanged", value: "123456" },
      { field: "newPassword", type: "fieldChanged", value: "a-new-password" },
      { type: "cancelled" },
    );

    expect(state).toMatchObject({
      code: "",
      error: null,
      identifier: "ada@example.com",
      newPassword: "",
      resendCooldown: 0,
      step: "credentials",
    });
  });
});

describe("validateSubmission", () => {
  it("requires a plausible email and a password on the credentials step", () => {
    expect(validateSubmission(initialSignInFormState)).toBe("Enter your email address.");
    expect(
      validateSubmission(
        reduce(initialSignInFormState, {
          field: "identifier",
          type: "fieldChanged",
          value: "ada",
        }),
      ),
    ).toBe("Enter a valid email address.");
    expect(
      validateSubmission(
        reduce(initialSignInFormState, {
          field: "identifier",
          type: "fieldChanged",
          value: " ada@example.com ",
        }),
      ),
    ).toBe("Enter your password.");
    expect(
      validateSubmission(
        reduce(
          initialSignInFormState,
          { field: "identifier", type: "fieldChanged", value: "ada@example.com" },
          { field: "password", type: "fieldChanged", value: "hunter22" },
        ),
      ),
    ).toBeNull();
  });

  it("only needs the email on the reset request step", () => {
    const state = reduce(
      initialSignInFormState,
      { field: "identifier", type: "fieldChanged", value: "ada@example.com" },
      { type: "resetRequested" },
    );

    expect(validateSubmission(state)).toBeNull();
  });

  it("requires a full code and a long enough new password", () => {
    const onCodeStep = reduce(
      initialSignInFormState,
      { field: "identifier", type: "fieldChanged", value: "ada@example.com" },
      { type: "resetRequested" },
      { type: "codeSent" },
    );

    expect(validateSubmission(onCodeStep)).toBe("Enter the 6-digit code we emailed you.");
    expect(
      validateSubmission(
        reduce(onCodeStep, { field: "code", type: "fieldChanged", value: "12345" }),
      ),
    ).toBe("Enter the 6-digit code we emailed you.");
    expect(
      validateSubmission(
        reduce(
          onCodeStep,
          { field: "code", type: "fieldChanged", value: "123456" },
          { field: "newPassword", type: "fieldChanged", value: "short" },
        ),
      ),
    ).toBe("Your new password needs at least 8 characters.");
    expect(
      validateSubmission(
        reduce(
          onCodeStep,
          { field: "code", type: "fieldChanged", value: "123456" },
          { field: "newPassword", type: "fieldChanged", value: "long-enough-password" },
        ),
      ),
    ).toBeNull();
  });
});

describe("describeUnexpectedSignInStatus", () => {
  it("explains the statuses this instance cannot serve", () => {
    expect(describeUnexpectedSignInStatus("needs_second_factor")).toBe(
      "This account has two-factor authentication enabled, which is not supported yet.",
    );
    expect(describeUnexpectedSignInStatus("needs_new_password")).toBe(
      "This account has to set a new password before signing in.",
    );
  });

  it("names an unknown status rather than swallowing it", () => {
    expect(describeUnexpectedSignInStatus("needs_client_trust")).toBe(
      "Sign in stopped at an unsupported step (needs_client_trust).",
    );
    expect(describeUnexpectedSignInStatus(null)).toBe("Sign in did not complete. Try again.");
  });
});

describe("resendCodeLabel", () => {
  it("shows the remaining cooldown until it expires", () => {
    expect(resendCodeLabel(30)).toBe("Resend code in 30s");
    expect(resendCodeLabel(1)).toBe("Resend code in 1s");
    expect(resendCodeLabel(0)).toBe("Resend code");
  });
});
