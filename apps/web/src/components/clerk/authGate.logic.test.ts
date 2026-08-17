import { describe, expect, it } from "vite-plus/test";

import { resolveClerkAuthGateState } from "./authGate.logic";

const validWorkspace = { workspaceValidation: "valid" as const };

describe("resolveClerkAuthGateState", () => {
  it("keeps the login and register routes public while Clerk loads", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: false,
        isSignedIn: undefined,
        onboardingComplete: undefined,
        pathname: "/login",
        ...validWorkspace,
      }),
    ).toBe("public");
    expect(
      resolveClerkAuthGateState({
        isLoaded: true,
        isSignedIn: false,
        onboardingComplete: undefined,
        pathname: "/register",
        ...validWorkspace,
      }),
    ).toBe("public");
  });

  it("waits for Clerk before deciding whether to redirect", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: false,
        isSignedIn: undefined,
        onboardingComplete: undefined,
        pathname: "/threads",
        ...validWorkspace,
      }),
    ).toBe("loading");
  });

  it("redirects signed-out users from application routes", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: true,
        isSignedIn: false,
        onboardingComplete: undefined,
        pathname: "/settings",
        ...validWorkspace,
      }),
    ).toBe("redirect");
  });

  it("redirects signed-out users away from the onboarding route", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: true,
        isSignedIn: false,
        onboardingComplete: undefined,
        pathname: "/onboarding",
        ...validWorkspace,
      }),
    ).toBe("redirect");
  });

  it("holds while the user profile is still loading", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: true,
        isSignedIn: true,
        onboardingComplete: undefined,
        pathname: "/threads",
        ...validWorkspace,
      }),
    ).toBe("loading");
  });

  it("routes signed-in users with an incomplete profile to onboarding", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: true,
        isSignedIn: true,
        onboardingComplete: false,
        pathname: "/threads",
        ...validWorkspace,
      }),
    ).toBe("onboarding");
  });

  it("lets an onboarding user stay on the onboarding route", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: true,
        isSignedIn: true,
        onboardingComplete: false,
        pathname: "/onboarding",
        ...validWorkspace,
      }),
    ).toBe("authenticated");
  });

  it("allows signed-in, onboarded users through", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: true,
        isSignedIn: true,
        onboardingComplete: true,
        pathname: "/threads",
        ...validWorkspace,
      }),
    ).toBe("authenticated");
  });

  it("holds a completed profile until its workspace is validated", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: true,
        isSignedIn: true,
        onboardingComplete: true,
        pathname: "/threads",
        workspaceValidation: "checking",
      }),
    ).toBe("loading");
  });

  it("does not reset onboarding when workspace validation is temporarily unavailable", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: true,
        isSignedIn: true,
        onboardingComplete: true,
        pathname: "/threads",
        workspaceValidation: "unavailable",
      }),
    ).toBe("authenticated");
  });
});
