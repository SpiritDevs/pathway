import { describe, expect, it } from "vite-plus/test";

import { resolveMobileAuthGateState } from "./authGate.logic";

const base = {
  hasClerkConfig: true,
  isLoaded: true,
  isSignedIn: true as boolean | undefined,
  onboardingComplete: true as boolean | undefined,
  workspaceValidation: "valid" as const,
};

describe("resolveMobileAuthGateState", () => {
  it("fails closed when no Clerk publishable key is configured", () => {
    expect(
      resolveMobileAuthGateState({
        ...base,
        hasClerkConfig: false,
        isLoaded: false,
        isSignedIn: undefined,
        onboardingComplete: undefined,
      }),
    ).toEqual("misconfigured");
  });

  it("misconfiguration outranks a signed-in session", () => {
    expect(resolveMobileAuthGateState({ ...base, hasClerkConfig: false })).toEqual("misconfigured");
  });

  it("holds on loading until Clerk resolves", () => {
    expect(
      resolveMobileAuthGateState({
        ...base,
        isLoaded: false,
        isSignedIn: undefined,
        onboardingComplete: undefined,
      }),
    ).toEqual("loading");
  });

  it("sends a signed-out visitor to the auth screens", () => {
    expect(
      resolveMobileAuthGateState({ ...base, isSignedIn: false, onboardingComplete: undefined }),
    ).toEqual("auth");
  });

  it("holds rather than guessing while the user object is still loading", () => {
    expect(resolveMobileAuthGateState({ ...base, onboardingComplete: undefined })).toEqual(
      "loading",
    );
  });

  it("blocks the app on onboarding when the profile is incomplete", () => {
    expect(resolveMobileAuthGateState({ ...base, onboardingComplete: false })).toEqual(
      "onboarding",
    );
  });

  it("lets a completed profile through", () => {
    expect(resolveMobileAuthGateState(base)).toEqual("authenticated");
  });

  it("holds a completed profile until its workspace is validated", () => {
    expect(resolveMobileAuthGateState({ ...base, workspaceValidation: "checking" })).toEqual(
      "loading",
    );
  });

  it("does not reset onboarding for a temporary validation failure", () => {
    expect(resolveMobileAuthGateState({ ...base, workspaceValidation: "unavailable" })).toEqual(
      "authenticated",
    );
  });
});
