import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";

vi.mock("./ui/select", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui/select")>()),
  SelectPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

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
  it("offers initialization instead of checkout and worktree choices for a plain directory", () => {
    const html = renderToStaticMarkup(
      <BranchToolbarEnvModeSelector
        envLocked={false}
        effectiveEnvMode="local"
        activeWorktreePath={null}
        workspaceRoot="/tmp/plain"
        displayMode="panel"
        repositoryReady={false}
        onInitializeGit={vi.fn()}
        onEnvModeChange={vi.fn()}
      />,
    );
    expect(html).toContain("Initialize Git");
    expect(html).not.toContain("Current checkout");
    expect(html).not.toContain("New worktree");
  });
  it("does not offer moving a plain directory to a worktree", () => {
    const html = renderToStaticMarkup(
      <BranchToolbarEnvModeSelector
        envLocked
        effectiveEnvMode="local"
        activeWorktreePath={null}
        workspaceRoot="/tmp/plain"
        displayMode="panel"
        repositoryReady={false}
        onInitializeGit={vi.fn()}
        onMoveToWorktree={vi.fn()}
        onEnvModeChange={vi.fn()}
      />,
    );
    expect(html).not.toContain('aria-label="Move thread to a worktree"');
  });
});
