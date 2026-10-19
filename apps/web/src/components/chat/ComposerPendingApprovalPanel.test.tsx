import { RuntimeRequestId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

function computerApproval(detail: string): PendingApproval {
  return {
    requestId: RuntimeRequestId.make("computer:approval-1"),
    requestKind: "computer",
    createdAt: "2026-07-18T00:00:00.000Z",
    detail,
    responseCapability: "live",
  };
}

function renderActions(approval: PendingApproval) {
  return renderToStaticMarkup(
    <ComposerPendingApprovalActions
      approval={approval}
      isResponding={false}
      canRespond
      onRespondToApproval={async () => undefined}
    />,
  );
}

describe("ComposerPendingApprovalPanel", () => {
  it("renders complete multiline command details without hover or truncation", () => {
    const detail = `bun run release -- ${"x".repeat(500)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: RuntimeRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
          responseCapability: "live",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain('aria-label="Command"');
    expect(markup).toContain(detail);
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("line-clamp");
    expect(markup).toContain("min-w-0");
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("[overflow-wrap:anywhere]");
  });

  it("asks for task consent without a session-wide approval", () => {
    const approval = computerApproval("Allow Computer for this task");
    const panel = renderToStaticMarkup(
      <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />,
    );
    const actions = renderActions(approval);

    expect(panel).toContain("Allow Computer for this task?");
    expect(panel).toContain("Stop cancels access");
    expect(panel).not.toContain("File-change approval requested");
    expect(actions).toContain("Allow Computer for this task");
    expect(actions).toContain("Stop revokes new input; keys/buttons already sent may still land.");
    expect(actions).toContain("Stop desktop for this turn, agent continues without tools");
    expect(actions).not.toContain("Always allow this session");
  });

  it("names the app for per-app consent", () => {
    const approval = computerApproval("Allow Computer to use Safari in this task");
    const panel = renderToStaticMarkup(
      <ComposerPendingApprovalPanel approval={approval} pendingCount={2} />,
    );

    expect(panel).toContain("Allow Computer to use Safari in this task?");
    expect(panel).toContain("1/2");
    expect(renderActions(approval)).toContain("Allow Safari for this task");
    expect(renderActions(approval)).not.toContain("Always allow this session");
  });

  it("describes a supervised call instead of printing the raw wire call", () => {
    const approval = computerApproval(
      'Computer action needs approval: computer_click {"x":812,"y":344,"label":"Save"}',
    );
    const panel = renderToStaticMarkup(
      <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />,
    );
    const actions = renderActions(approval);

    expect(panel).toContain("Approve this tool call?");
    expect(panel).toContain("Click on “Save”");
    expect(panel).toContain("812, 344");
    expect(panel).not.toContain("{&quot;x&quot;");
    expect(actions).toContain("Approve once");
    expect(actions).toContain("Decline");
    expect(actions).toContain("Cancel turn");
    expect(actions).not.toContain("Always allow this session");
  });

  it("keeps all four actions, numbered in shortcut order, for other approvals", () => {
    const actions = renderActions({
      requestId: RuntimeRequestId.make("approval-2"),
      requestKind: "command",
      createdAt: "2026-07-18T00:00:00.000Z",
      detail: "ls",
      responseCapability: "live",
    });

    for (const [label, shortcut] of [
      ["Approve once", "1"],
      ["Always allow this session", "2"],
      ["Decline", "3"],
      ["Cancel turn", "4"],
    ] as const) {
      expect(actions).toMatch(
        new RegExp(`aria-keyshortcuts="${shortcut}"[^>]*>${label}<kbd[^>]*>${shortcut}</kbd>`),
      );
    }
  });
});
