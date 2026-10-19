export interface OnboardingSearch {
  readonly intent?: "create-company";
}

export function parseOnboardingSearch(raw: Record<string, unknown>): OnboardingSearch {
  return raw.intent === "create-company" ? { intent: "create-company" } : {};
}
