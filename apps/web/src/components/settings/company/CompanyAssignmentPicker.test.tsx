import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: ReadonlyArray<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (input: { item: { id: string } }) => ReactNode;
  }) => (
    <div data-testid="legend-list">
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
    </div>
  ),
}));

let CompanyAssignmentPicker: typeof import("./CompanyAssignmentPicker").CompanyAssignmentPicker;

beforeAll(async () => {
  ({ CompanyAssignmentPicker } = await import("./CompanyAssignmentPicker"));
});

describe("CompanyAssignmentPicker", () => {
  it("renders full-width accessible rows, controls, counts, badges, and disabled reasons", () => {
    const html = renderToStaticMarkup(
      <CompanyAssignmentPicker
        label="Teams"
        items={[
          {
            id: "alpha",
            primaryLabel: "Alpha",
            secondaryLabel: "Product team",
            searchableText: "Alpha Product team",
            selected: false,
            mayAdd: true,
            mayRemove: false,
          },
          {
            id: "archive",
            primaryLabel: "Archive",
            searchableText: "Archive",
            status: "archived",
            statusLabel: "Archived",
            selected: true,
            mayAdd: false,
            mayRemove: true,
            disabledReason: "Archived teams cannot gain members.",
          },
        ]}
        onToggle={() => {}}
        onVisibleChange={() => {}}
      />,
    );
    expect(html).toContain("Search teams");
    expect(html).toContain("Filter teams");
    expect(html).toContain("2 results · 1 selected");
    expect(html).toContain("Add Alpha");
    expect(html).toContain("Remove Archive");
    expect(html).toContain("Archived");
    expect(html).toContain("w-full");
  });

  it("blocks bulk actions while pending", () => {
    const html = renderToStaticMarkup(
      <CompanyAssignmentPicker
        label="Members"
        pending
        items={[
          {
            id: "ada",
            primaryLabel: "Ada",
            searchableText: "Ada",
            selected: false,
            mayAdd: true,
            mayRemove: false,
          },
        ]}
        onToggle={() => {}}
        onVisibleChange={() => {}}
      />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("Select visible");
  });
});
