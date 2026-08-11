import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../clerk/T3ConnectSidebarSignIn", () => ({
  T3ConnectProfileButton: () => <button data-testid="profile-button">Profile</button>,
}));

import { WorkspaceTopBar } from "./WorkspaceTopBar";

describe("WorkspaceTopBar", () => {
  it("keeps the Clerk profile control visible at the top right of desktop workspaces", () => {
    const markup = renderToStaticMarkup(<WorkspaceTopBar />);

    expect(markup).toContain('data-workspace-top-bar=""');
    expect(markup).toContain('data-testid="profile-button"');
    expect(markup).toContain("justify-end");
    expect(markup).toContain("pr-4");
    expect(markup).toContain("md:flex");
  });
});
