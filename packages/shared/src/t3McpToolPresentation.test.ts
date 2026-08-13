import { describe, expect, it } from "vite-plus/test";

import { resolveT3McpToolPresentation } from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
  it("pretty prints Claude and Cursor Pathway MCP tool names", () => {
    expect(resolveT3McpToolPresentation("mcp__pathway__t3_thread_read")).toEqual({
      displayName: "Read a Pathway thread",
      logo: "pathway",
    });
  });

  it("pretty prints Codex Pathway MCP tool names", () => {
    expect(resolveT3McpToolPresentation("pathway.create_threads")).toEqual({
      displayName: "Create Pathway threads",
      logo: "pathway",
    });
  });

  it("pretty prints bare Pathway MCP toolkit names", () => {
    expect(resolveT3McpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "pathway",
    });
  });

  it("pretty prints worktree Pathway MCP tool names", () => {
    expect(resolveT3McpToolPresentation("mcp__pathway__t3_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "pathway",
    });
    expect(resolveT3McpToolPresentation("pathway.t3_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "pathway",
    });
  });

  it("pretty prints preview Pathway MCP tool names", () => {
    expect(resolveT3McpToolPresentation("pathway.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "pathway",
    });
    expect(resolveT3McpToolPresentation("mcp__pathway__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "pathway",
    });
  });

  it("pretty prints issue and email tools and retains old transcript aliases", () => {
    expect(resolveT3McpToolPresentation("mcp__pathway__issues_get")).toEqual({
      displayName: "Read a Pathway issue",
      logo: "pathway",
    });
    expect(resolveT3McpToolPresentation("pathway.email_latest_code")).toEqual({
      displayName: "Get latest email code",
      logo: "pathway",
    });
    expect(resolveT3McpToolPresentation("mcp__t3-code__issues_get")).toEqual({
      displayName: "Read a Pathway issue",
      logo: "pathway",
    });
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveT3McpToolPresentation("mcp__github__search_issues")).toBeNull();
  });
});
