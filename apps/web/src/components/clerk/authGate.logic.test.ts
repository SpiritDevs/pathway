import { describe, expect, it } from "vite-plus/test";

import { resolveClerkAuthGateState } from "./authGate.logic";

describe("resolveClerkAuthGateState", () => {
  it("keeps the login and register routes public while Clerk loads", () => {
    expect(
      resolveClerkAuthGateState({
        isLoaded: false,
        isSignedIn: undefined,
        onboardingComplete: undefined,
        pathname: "/login",
      }),
    ).toBe("public");
    expect(
      resolveClerkAuthGateState({
        isLoaded: true,
        isSignedIn: false,
        onboardingComplete: undefined,
        pathname: "/register",
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
      }),
    ).toBe("authenticated");
  });
});
