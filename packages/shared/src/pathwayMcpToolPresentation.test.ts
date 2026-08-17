import { describe, expect, it } from "vite-plus/test";

import { resolvePathwayMcpToolPresentation } from "./pathwayMcpToolPresentation.ts";

describe("resolvePathwayMcpToolPresentation", () => {
  it("pretty prints Claude and Cursor Pathway MCP tool names", () => {
    expect(resolvePathwayMcpToolPresentation("mcp__pathway__pathway_thread_read")).toEqual({
      displayName: "Read a Pathway thread",
      logo: "pathway",
    });
  });

  it("pretty prints Codex Pathway MCP tool names", () => {
    expect(resolvePathwayMcpToolPresentation("pathway.create_threads")).toEqual({
      displayName: "Create Pathway threads",
      logo: "pathway",
    });
  });

  it("pretty prints bare Pathway MCP toolkit names", () => {
    expect(resolvePathwayMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "pathway",
    });
  });

  it("pretty prints worktree Pathway MCP tool names", () => {
    expect(resolvePathwayMcpToolPresentation("mcp__pathway__pathway_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "pathway",
    });
    expect(resolvePathwayMcpToolPresentation("pathway.pathway_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "pathway",
    });
  });

  it("pretty prints preview Pathway MCP tool names", () => {
    expect(resolvePathwayMcpToolPresentation("pathway.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "pathway",
    });
    expect(resolvePathwayMcpToolPresentation("mcp__pathway__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "pathway",
    });
  });

  it("pretty prints issue and email tools and retains old transcript aliases", () => {
    expect(resolvePathwayMcpToolPresentation("mcp__pathway__issues_get")).toEqual({
      displayName: "Read a Pathway issue",
      logo: "pathway",
    });
    expect(resolvePathwayMcpToolPresentation("mcp__pathway__issues_get_attachment")).toEqual({
      displayName: "Read a Pathway issue attachment",
      logo: "pathway",
    });
    expect(resolvePathwayMcpToolPresentation("mcp__pathway__issues_comment_evidence")).toEqual({
      displayName: "Attach browser evidence to a Pathway issue",
      logo: "pathway",
    });
    expect(resolvePathwayMcpToolPresentation("pathway.email_latest_code")).toEqual({
      displayName: "Get latest email code",
      logo: "pathway",
    });
    expect(resolvePathwayMcpToolPresentation("mcp__pathway__issues_get")).toEqual({
      displayName: "Read a Pathway issue",
      logo: "pathway",
    });
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolvePathwayMcpToolPresentation("mcp__github__search_issues")).toBeNull();
  });
});
