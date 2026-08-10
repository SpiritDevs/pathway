import { describe, expect, it } from "@effect/vitest";

import { resolveSecondarySidebarKind, shouldRenderSecondarySidebar } from "./secondarySidebar";

describe("resolveSecondarySidebarKind", () => {
  it.each([
    ["/", null],
    ["/threads", "threads"],
    ["/threads/draft/new", "threads"],
    ["/threads/environment/thread", "threads"],
    ["/issues", "issues"],
    ["/issues/assigned", "issues"],
    ["/settings", "settings"],
    ["/settings/connections", "settings"],
    ["/pull-requests", "source-control"],
    ["/pull-requests/42", "source-control"],
    ["/calendar", "calendar"],
    ["/calendar/week", "calendar"],
    ["/email", "email"],
    ["/orchestrator", "orchestrator"],
    ["/orchestrator/agents", "orchestrator"],
    ["/usage", null],
    ["/dashboard", null],
  ] as const)("maps %s to %s", (pathname, sidebarKind) => {
    expect(resolveSecondarySidebarKind(pathname)).toBe(sidebarKind);
  });
});

describe("shouldRenderSecondarySidebar", () => {
  it("keeps the drawer available on mobile routes without a desktop sidebar", () => {
    expect(shouldRenderSecondarySidebar(true, null)).toBe(true);
  });

  it("hides routes without a contextual sidebar on desktop", () => {
    expect(shouldRenderSecondarySidebar(false, null)).toBe(false);
  });

  it("shows contextual sidebars on desktop", () => {
    expect(shouldRenderSecondarySidebar(false, "threads")).toBe(true);
    expect(shouldRenderSecondarySidebar(false, "settings")).toBe(true);
    expect(shouldRenderSecondarySidebar(false, "email")).toBe(true);
    expect(shouldRenderSecondarySidebar(false, "calendar")).toBe(true);
    expect(shouldRenderSecondarySidebar(false, "orchestrator")).toBe(true);
    expect(shouldRenderSecondarySidebar(false, "issues")).toBe(true);
    expect(shouldRenderSecondarySidebar(false, "source-control")).toBe(true);
  });
});
