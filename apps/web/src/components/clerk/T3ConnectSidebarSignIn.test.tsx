import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useClerk: () => ({ openUserProfile: vi.fn(), signOut: vi.fn() }),
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: {
      fullName: "Corey Baines",
      imageUrl: "https://example.test/corey.png",
      primaryEmailAddress: { emailAddress: "corey@example.test" },
    },
  }),
}));

vi.mock("../../cloud/publicConfig", () => ({
  hasClerkPublicConfig: () => true,
  hasCloudPublicConfig: () => true,
}));

vi.mock("../ui/menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  DropdownMenuTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("./MobileClientsUserProfilePage", () => ({
  MobileClientsUserProfilePage: () => <div>Mobile clients</div>,
}));

vi.mock("../usage/ProviderUsage", () => ({
  ConnectedProviderUsageMenu: () => <div>Connected provider limits</div>,
}));

import { T3ConnectProfileButton } from "./T3ConnectSidebarSignIn";

describe("T3ConnectProfileButton", () => {
  it("renders the signed-in user and the existing account actions in a Pathway menu", () => {
    const markup = renderToStaticMarkup(<T3ConnectProfileButton />);

    expect(markup).toContain("Open profile menu for Corey Baines");
    expect(markup).toContain("https://example.test/corey.png");
    expect(markup).toContain("corey@example.test");
    expect(markup).toContain("Provider usage");
    expect(markup).toContain("Connected provider limits");
    expect(markup).toContain("Manage account");
    expect(markup).toContain("Sign out");
    expect(markup).not.toContain("cl-userButton");
  });
});
