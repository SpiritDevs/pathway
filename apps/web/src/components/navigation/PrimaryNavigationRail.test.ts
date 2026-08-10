import { describe, expect, it } from "@effect/vitest";

import {
  PRIMARY_NAVIGATION_COMPACT_WIDTH,
  PRIMARY_NAVIGATION_EXPANDED_WIDTH,
  resolvePrimaryNavigationDestination,
  resolvePrimaryNavigationRailWidth,
} from "./PrimaryNavigationRail";

describe("resolvePrimaryNavigationDestination", () => {
  it.each([
    ["/", "dashboard"],
    ["/dashboard", "dashboard"],
    ["/threads", "threads"],
    ["/threads/draft/new", "threads"],
    ["/threads/environment/thread", "threads"],
    ["/issues", "issues"],
    ["/issues/assigned", "issues"],
    ["/pull-requests", "pull-requests"],
    ["/calendar", "calendar"],
    ["/email", "email"],
    ["/orchestrator", "orchestrator"],
    ["/orchestrator/agents", "orchestrator"],
    ["/usage", "settings"],
    ["/settings/usage", "settings"],
    ["/settings", "settings"],
    ["/settings/connections", "settings"],
  ] as const)("maps %s to %s", (pathname, destination) => {
    expect(resolvePrimaryNavigationDestination(pathname)).toBe(destination);
  });
});

describe("resolvePrimaryNavigationRailWidth", () => {
  it("uses the compact width when minimized", () => {
    expect(resolvePrimaryNavigationRailWidth(false)).toBe(PRIMARY_NAVIGATION_COMPACT_WIDTH);
  });

  it("uses the expanded width when labels are visible", () => {
    expect(resolvePrimaryNavigationRailWidth(true)).toBe(PRIMARY_NAVIGATION_EXPANDED_WIDTH);
  });
});
