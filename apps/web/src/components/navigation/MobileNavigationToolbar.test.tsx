import { LayoutDashboardIcon, MessagesSquareIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MobileNavigationToolbar } from "./PrimaryNavigationRail";

describe("MobileNavigationToolbar", () => {
  it("starts as a compact handle with its navigation controls out of the tab order", () => {
    const markup = renderToStaticMarkup(
      <MobileNavigationToolbar
        activeDestination="threads"
        items={[
          {
            destination: "dashboard",
            icon: LayoutDashboardIcon,
            label: "Dashboard",
            onNavigate: () => undefined,
          },
          {
            destination: "threads",
            icon: MessagesSquareIcon,
            label: "Threads",
            onNavigate: () => undefined,
          },
        ]}
      />,
    );

    expect(markup).toContain('data-mobile-primary-navigation=""');
    expect(markup).toContain('aria-label="Open primary navigation"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Primary navigation"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain('aria-label="Collapse primary navigation"');
    expect(markup).toContain('tabindex="-1"');
  });
});
