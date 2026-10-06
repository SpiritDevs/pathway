import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadId } from "@spiritdevs/contracts";

import {
  formatAgentElapsed,
  isPreviousAgentRow,
  resolveThreadLineageWindow,
  ThreadLineageRowList,
} from "./ThreadRelationshipsControl";

const rows = Array.from({ length: 20 }, (_, index) => `row-${index}`);

function renderRowList(visibleCount: number) {
  const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, visibleCount);
  return renderToStaticMarkup(
    <ThreadLineageRowList hiddenCount={hiddenCount} onShowMore={() => {}}>
      {visibleRows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ThreadLineageRowList>,
  );
}

describe("thread lineage row list", () => {
  it("shows six rows before the first expansion", () => {
    const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, 6);

    expect(visibleRows).toEqual(rows.slice(0, 6));
    expect(hiddenCount).toBe(14);
  });

  it("offers one page at a time", () => {
    expect(renderRowList(6)).toContain("Show 12 more");
    expect(renderRowList(6 + 12)).toContain("Show 2 more");
  });

  it("omits the expansion affordance when everything fits", () => {
    const markup = renderRowList(rows.length);

    expect(markup).not.toContain("more");
    expect(resolveThreadLineageWindow(rows.slice(0, 6), 6).hiddenCount).toBe(0);
  });

  it("keeps the rows in a bounded, labelled scroll region and the button outside it", () => {
    const markup = renderRowList(6);
    const list = /<ul([^>]*)>/.exec(markup)?.[1] ?? "";

    expect(list).toContain('aria-label="Related threads"');
    expect(list).toContain("max-h-[13.5rem]");
    expect(list).toContain("overflow-y-auto");
    expect(list).not.toContain("overscroll-contain");
    expect(markup.indexOf("</ul>")).toBeLessThan(markup.indexOf("<button"));
  });
});

describe("previous agents", () => {
  const current = "thread-current" as ThreadId;
  const subagent = (status: string | null, sourceThreadId = current) =>
    ({ kind: "subagent", sourceThreadId, status }) as const;

  it("files this thread's finished subagents under previous agents", () => {
    for (const status of ["completed", "failed", "cancelled", "interrupted"]) {
      expect(isPreviousAgentRow(subagent(status), current)).toBe(true);
    }
  });

  it("keeps live subagents, parent agents, and other relationships in the main list", () => {
    expect(isPreviousAgentRow(subagent("running"), current)).toBe(false);
    expect(isPreviousAgentRow(subagent("waiting"), current)).toBe(false);
    expect(isPreviousAgentRow(subagent(null), current)).toBe(false);
    expect(isPreviousAgentRow(subagent("completed", "thread-parent" as ThreadId), current)).toBe(
      false,
    );
    expect(
      isPreviousAgentRow({ kind: "fork", sourceThreadId: current, status: "completed" }, current),
    ).toBe(false);
  });
});

describe("agent elapsed label", () => {
  it("shows seconds, then minutes and seconds, then hours and minutes", () => {
    expect(formatAgentElapsed(9_400)).toBe("9s");
    expect(formatAgentElapsed(87_000)).toBe("1m 27s");
    expect(formatAgentElapsed(3_723_000)).toBe("1h 2m");
    expect(formatAgentElapsed(-5)).toBe("0s");
  });
});
