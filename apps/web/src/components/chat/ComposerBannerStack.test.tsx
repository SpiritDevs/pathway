import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

const banner = (
  id: string,
  variant: ComposerBannerStackItem["variant"] = "warning",
): ComposerBannerStackItem => ({
  id,
  variant,
  icon: <span aria-hidden="true">!</span>,
  title: `${id} warning`,
});

describe("ComposerBannerStack", () => {
  it("keeps expanded banners in layout flow so surrounding content moves out of their way", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack items={[banner("front"), banner("stacked")]} />,
    );

    const expandedItems = markup.match(
      /<div data-composer-banner-stack-expanded-items="true" class="([^"]+)">/,
    );

    expect(expandedItems?.[1]).toContain("grid-rows-[0fr]");
    expect(expandedItems?.[1]).toContain("group-hover/banner-stack:grid-rows-[1fr]");
    expect(expandedItems?.[1]).toContain("z-20");
    expect(expandedItems?.[1]).not.toContain("absolute");
    expect(markup.indexOf("front warning")).toBeLessThan(markup.indexOf("stacked warning"));
    expect(markup).toContain("invisible pointer-events-none");
    expect(markup).toContain("group-focus-within/banner-stack:visible");
  });

  it("colors the collapsed stack cap by the hidden banner's variant, not a fixed warning", () => {
    const neutralBehind = renderToStaticMarkup(
      <ComposerBannerStack items={[banner("front", "default"), banner("stacked", "default")]} />,
    );
    expect(neutralBehind).toContain("border-border");
    expect(neutralBehind).not.toContain("border-warning/24");

    const warningBehind = renderToStaticMarkup(
      <ComposerBannerStack items={[banner("front", "default"), banner("stacked", "warning")]} />,
    );
    expect(warningBehind).toContain("border-warning/24");
  });

  it("does not render an expandable region for a single banner", () => {
    const markup = renderToStaticMarkup(<ComposerBannerStack items={[banner("front")]} />);

    expect(markup).not.toContain("data-composer-banner-stack-expanded-items");
    expect(markup).toContain("alert-glass");
    expect(markup).toContain('data-variant="warning"');
    expect(markup).toContain("transform:none");
    expect(markup).not.toContain("will-change:transform");
  });

  it("applies item-specific surface and action layout classes", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          {
            ...banner("branch"),
            className: "branch-surface",
            actionClassName: "branch-actions",
            actions: <button type="button">Repair</button>,
          },
        ]}
      />,
    );

    expect(markup).toContain("branch-surface");
    expect(markup).toContain("branch-actions");
  });

  it("renders a lone lip as a compact surface attached to the composer", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[{ ...banner("version"), presentation: "lip", onDismiss: () => {} }]}
      />,
    );

    expect(markup).toContain("px-[1.375rem]");
    expect(markup).toContain("-mb-2 pt-1");
    expect(markup).toContain('data-presentation="lip"');
    expect(markup).toContain("min-h-8 rounded-b-none rounded-t-[14px]");
    expect(markup).not.toContain("rounded-[22px]");
  });

  it("keeps the front lip attached when notices are stacked", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[{ ...banner("version"), presentation: "lip" }, banner("connection")]}
      />,
    );

    expect(markup).toContain('data-presentation="lip"');
    expect(markup).toContain("rounded-b-none");
    expect(markup).not.toContain("rounded-[22px]");
    expect(markup).not.toContain("space-y-2 pb-2");
  });
  it("shows at most two progressively smaller peeks while keeping every notice available", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[banner("front"), banner("second"), banner("third"), banner("fourth")]}
      />,
    );
    expect(markup.match(/data-composer-banner-stack-peek=/g)).toHaveLength(2);
    expect(markup).toContain("width:96%;top:-8px");
    expect(markup).toContain("width:92%;top:-16px");
    expect(markup).toContain("fourth warning");
    expect(markup.indexOf("fourth warning")).toBeLessThan(markup.indexOf("second warning"));
  });
});
