import { describe, expect, it } from "@effect/vitest";

import {
  PRIMARY_NAVIGATION_COMPACT_WIDTH,
  PRIMARY_NAVIGATION_EXPANDED_WIDTH,
  resolvePrimaryNavigationDestination,
  resolvePrimaryNavigationRailWidth,
  resolveRememberedThreadRoute,
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
