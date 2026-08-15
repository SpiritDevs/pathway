import { describe, expect, it } from "@effect/vitest";

import {
  formatNavigationBadgeCount,
  movePrimaryNavigationDestination,
  PRIMARY_NAVIGATION_COMPACT_WIDTH,
  PRIMARY_NAVIGATION_EXPANDED_WIDTH,
  PRIMARY_NAVIGATION_MOVABLE_DESTINATIONS,
  resolvePrimaryNavigationDestination,
  resolvePrimaryNavigationRailWidth,
  resolvePrimaryNavigationViewOrder,
  resolveRememberedThreadRoute,
} from "./PrimaryNavigationRail";

describe("formatNavigationBadgeCount", () => {
  it("keeps small counts exact", () => {
    expect(formatNavigationBadgeCount(1)).toBe("1");
    expect(formatNavigationBadgeCount(99)).toBe("99");
  });

  it("caps the label so it still fits a rail button", () => {
    expect(formatNavigationBadgeCount(100)).toBe("99+");
  });
});

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
    ["/contacts", "contacts"],
    ["/time-tracker", "time-tracker"],
    ["/files", "files"],
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

describe("primary navigation view order", () => {
  it("keeps a valid preference and appends newly introduced views", () => {
    expect(resolvePrimaryNavigationViewOrder(["email", "threads"])).toEqual([
      "email",
      "threads",
      "issues",
      "pull-requests",
      "calendar",
      "contacts",
      "time-tracker",
      "files",
    ]);
  });

  it("discards fixed, unknown, and duplicate destinations", () => {
    expect(
      resolvePrimaryNavigationViewOrder([
        "settings",
        "issues",
        "dashboard",
        "issues",
        "future-view",
      ]),
    ).toEqual([
      "issues",
      "threads",
      "pull-requests",
      "calendar",
      "email",
      "contacts",
      "time-tracker",
      "files",
    ]);
    expect(PRIMARY_NAVIGATION_MOVABLE_DESTINATIONS).not.toContain("dashboard");
    expect(PRIMARY_NAVIGATION_MOVABLE_DESTINATIONS).not.toContain("orchestrator");
    expect(PRIMARY_NAVIGATION_MOVABLE_DESTINATIONS).not.toContain("settings");
  });

  it("moves a view one position without crossing either boundary", () => {
    const order = resolvePrimaryNavigationViewOrder([]);

    expect(movePrimaryNavigationDestination(order, "issues", "up")).toEqual([
      "issues",
      "threads",
      "pull-requests",
      "calendar",
      "email",
      "contacts",
      "time-tracker",
      "files",
    ]);
    expect(movePrimaryNavigationDestination(order, "threads", "up")).toBe(order);
    expect(movePrimaryNavigationDestination(order, "files", "down")).toBe(order);
  });
});

describe("resolveRememberedThreadRoute", () => {
  it("remembers a server thread while visiting another view", () => {
    const selectedThread = resolveRememberedThreadRoute("/threads/environment-1/thread-1", null);

    expect(resolveRememberedThreadRoute("/issues", selectedThread)).toEqual({
      kind: "thread",
      environmentId: "environment-1",
      threadId: "thread-1",
    });
  });

  it("remembers a draft thread while visiting another view", () => {
    const selectedDraft = resolveRememberedThreadRoute("/threads/draft/draft-1", null);

    expect(resolveRememberedThreadRoute("/calendar", selectedDraft)).toEqual({
      kind: "draft",
      draftId: "draft-1",
    });
  });

  it("updates the remembered route when another thread is selected", () => {
    const previous = resolveRememberedThreadRoute("/threads/environment-1/thread-1", null);

    expect(resolveRememberedThreadRoute("/threads/environment-2/thread-2", previous)).toEqual({
      kind: "thread",
      environmentId: "environment-2",
      threadId: "thread-2",
    });
  });

  it("clears the remembered route on the threads landing", () => {
    const previous = resolveRememberedThreadRoute("/threads/environment-1/thread-1", null);

    expect(resolveRememberedThreadRoute("/threads", previous)).toBeNull();
  });

  it("decodes route parameters before reusing them for navigation", () => {
    expect(resolveRememberedThreadRoute("/threads/local%20host/thread%2Fone", null)).toEqual({
      kind: "thread",
      environmentId: "local host",
      threadId: "thread/one",
    });
  });
});
