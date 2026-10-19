import { describe, expect, it } from "vite-plus/test";

import { parseOnboardingSearch } from "./onboardingRoute.logic";

describe("parseOnboardingSearch", () => {
  it("accepts the additional-company onboarding intent", () => {
    expect(parseOnboardingSearch({ intent: "create-company" })).toEqual({
      intent: "create-company",
    });
  });

  it("drops unknown onboarding intents", () => {
    expect(parseOnboardingSearch({ intent: "replace-company" })).toEqual({});
  });
});
