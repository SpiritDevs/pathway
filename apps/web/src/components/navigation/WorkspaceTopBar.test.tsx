import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useCanGoBack: () => false,
  useRouter: () => ({
    history: {
      back: vi.fn(),
      forward: vi.fn(),
      location: { state: { __TSR_index: 0 } },
      subscribe: () => () => {},
    },
  }),
}));

vi.mock("../clerk/T3ConnectSidebarSignIn", () => ({
  T3ConnectProfileButton: () => <button data-testid="profile-button">Profile</button>,
}));

import { WorkspaceTopBar } from "./WorkspaceTopBar";

describe("WorkspaceTopBar", () => {
  it("keeps the Clerk profile control visible at the top right of desktop workspaces", () => {
    const markup = renderToStaticMarkup(<WorkspaceTopBar />);

    expect(markup).toContain('data-workspace-top-bar=""');
    expect(markup).toContain('data-testid="profile-button"');
    expect(markup).toContain('aria-label="Back"');
    expect(markup).toContain('aria-label="Forward"');
    expect(markup).toContain("justify-between");
    expect(markup).toContain("pr-4");
    expect(markup).toContain("md:flex");
  });
});
