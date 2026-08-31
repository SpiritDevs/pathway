import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";

describe("BranchToolbarEnvModeSelector", () => {
  it("shows the worktree move button beside a locked project folder", () => {
    const html = renderToStaticMarkup(
      <BranchToolbarEnvModeSelector
        displayMode="panel"
        envLocked
        effectiveEnvMode="local"
        activeWorktreePath={null}
        workspaceRoot="/tmp/pathway"
        onEnvModeChange={vi.fn()}
        onMoveToWorktree={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Move thread to a worktree"');
    expect(html).toContain("pathway");
    expect(html).toContain("Project folder");
  });

  it("does not show the move button for an existing worktree", () => {
    const html = renderToStaticMarkup(
      <BranchToolbarEnvModeSelector
        displayMode="panel"
        envLocked
        effectiveEnvMode="local"
        activeWorktreePath="/tmp/pathway-worktree"
        workspaceRoot="/tmp/pathway"
        onEnvModeChange={vi.fn()}
        onMoveToWorktree={vi.fn()}
      />,
    );

    expect(html).not.toContain('aria-label="Move thread to a worktree"');
  });
});
