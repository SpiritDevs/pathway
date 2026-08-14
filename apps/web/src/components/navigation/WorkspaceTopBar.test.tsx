import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../clerk/T3ConnectSidebarSignIn", () => ({
  T3ConnectProfileButton: () => <button data-testid="profile-button">Profile</button>,
}));

// The bar renders history controls, which read router context. This suite is a
// static-markup layout smoke, not a navigation test, so the two hooks are stubbed
// instead of standing up a RouterProvider; everything else in the module is kept.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({
    history: {
      location: { state: { __TSR_index: 0 } },
      subscribe: () => () => {},
      back: () => {},
      forward: () => {},
    },
  }),
  useCanGoBack: () => false,
}));

import { WorkspaceTopBar } from "./WorkspaceTopBar";

describe("WorkspaceTopBar", () => {
  it("keeps the Clerk profile control visible at the top right of desktop workspaces", () => {
    const markup = renderToStaticMarkup(<WorkspaceTopBar />);

    expect(markup).toContain('data-workspace-top-bar=""');
    expect(markup).toContain('data-testid="profile-button"');
    // History controls sit on the left, so the bar spreads its two children and
    // the profile button lands at the right edge.
    expect(markup).toContain("justify-between");
    expect(markup).toContain('aria-label="History navigation"');
    expect(markup).toContain("pr-4");
    expect(markup).toContain("md:flex");
  });
});
