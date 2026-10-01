import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    history: {
      go: vi.fn(),
      location: {
        hash: "",
        href: "/threads",
        pathname: "/threads",
        search: "",
        state: { __TSR_index: 0 },
      },
      subscribe: () => () => {},
    },
  }),
}));

vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuGroupLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { WorkspaceTopBar } from "./WorkspaceTopBar";

describe("WorkspaceTopBar", () => {
  it("holds only history navigation; account and status controls live in the rail", () => {
    const markup = renderToStaticMarkup(<WorkspaceTopBar />);

    expect(markup).toContain('data-workspace-top-bar=""');
    expect(markup).not.toContain("Open profile menu");
    expect(markup).not.toContain('aria-label="Environment storage"');
    expect(markup).toContain('aria-label="History navigation"');
    expect(markup).toContain('aria-label="Back"');
    expect(markup).toContain('aria-label="Forward"');
    expect(markup).not.toContain("Back history");
    expect(markup).not.toContain("Forward history");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain("pr-4");
    expect(markup).toContain("md:flex");
  });
});
