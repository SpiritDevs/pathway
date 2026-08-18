import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { atoms, testState } = vi.hoisted(() => ({
  atoms: {
    activeCompanyId: Symbol("active-company-id"),
    companyList: Symbol("company-list"),
  },
  testState: {
    activeCompanyId: "company-b",
    companies: [] as ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly workspaceKind: "personal" | "organization";
    }>,
    setActiveCompanyId: vi.fn(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtom: (_atom: symbol) => [testState.activeCompanyId, testState.setActiveCompanyId],
  useAtomValue: (atom: symbol) => (atom === atoms.companyList ? testState.companies : null),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

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

vi.mock("../../cloud/activeCompany", () => ({
  activeCompanyIdAtom: atoms.activeCompanyId,
  companyListAtom: atoms.companyList,
}));

vi.mock("../ui/menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuCheckboxItem: ({ checked, children }: { checked: boolean; children: ReactNode }) => (
    <button data-checked={checked}>{children}</button>
  ),
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

vi.mock("../settings/company/CreateCompanyDialog", () => ({
  CreateCompanyDialog: () => <div>Create company dialog</div>,
}));

import { PathwayConnectProfileButton } from "./PathwayConnectSidebarSignIn";

describe("PathwayConnectProfileButton", () => {
  beforeEach(() => {
    testState.activeCompanyId = "company-b";
    testState.companies = [];
    testState.setActiveCompanyId.mockClear();
  });

  it("renders the signed-in user and the existing account actions in a Pathway menu", () => {
    const markup = renderToStaticMarkup(<PathwayConnectProfileButton />);

    expect(markup).toContain("Open profile menu for Corey Baines");
    expect(markup).toContain("https://example.test/corey.png");
    expect(markup).toContain("corey@example.test");
    expect(markup).toContain("Provider usage");
    expect(markup).toContain("Connected provider limits");
    expect(markup).toContain("Manage account");
    expect(markup).toContain("Sign out");
    expect(markup).not.toContain("cl-userButton");
  });

  it("keeps the personal workspace out of the company list while offering company creation", () => {
    testState.companies = [
      { id: "company-a", name: "Corey's Workspace", workspaceKind: "personal" },
    ];

    const markup = renderToStaticMarkup(<PathwayConnectProfileButton />);

    expect(markup).toContain("Company");
    expect(markup).toContain("Create company");
    expect(markup).not.toContain("Corey&#x27;s Workspace");
  });

  it("lists synced companies and checks the active company", () => {
    testState.companies = [
      { id: "company-a", name: "Acme", workspaceKind: "organization" },
      { id: "company-b", name: "Beta Labs", workspaceKind: "organization" },
    ];

    const markup = renderToStaticMarkup(<PathwayConnectProfileButton />);

    expect(markup).toContain("Company");
    expect(markup).toContain("All companies");
    expect(markup).toContain("Acme");
    expect(markup).toContain("Beta Labs");
    expect(markup).toContain("Open settings for Acme");
    expect(markup).toContain("Create company");
    expect(markup).toContain('data-checked="true"');
  });
});
