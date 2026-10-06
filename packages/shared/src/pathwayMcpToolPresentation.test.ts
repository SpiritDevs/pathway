import { describe, expect, it } from "vite-plus/test";

import {
  resolvePathwayMcpToolId,
  resolvePathwayMcpToolPresentation,
} from "./pathwayMcpToolPresentation.ts";

describe("resolvePathwayMcpToolPresentation", () => {
  it("labels inline HTML tools and resolves every own provider spelling", () => {
    for (const id of ["html_render", "html_preview"]) {
      for (const spelling of [
        id,
        `pathway.${id}`,
        `pathway/${id}`,
        `pathway:${id}`,
        `mcp__pathway__${id}`,
        `mcp__pathway_code__${id}`,
        `pathway_${id}`,
        `pathway_code_${id}`,
        `${id} completed`,
      ]) {
        expect(resolvePathwayMcpToolId(spelling)).toBe(id);
        expect(resolvePathwayMcpToolPresentation(spelling)?.displayName).toBe(
          id === "html_render" ? "Render an HTML page" : "Preview an HTML page",
        );
      }
    }
  });

  it("rejects unrelated servers, unknown ids, and ambiguous underscore suffixes", () => {
    for (const spelling of [
      null,
      undefined,
      "mcp__other__html_render",
      "other.html_render",
      "other_html_render",
      "pathway-thread_1_html_render",
      "pathway_other_html_render",
      "pathway.not_a_tool",
      "pathway_not_a_tool",
    ]) {
      expect(resolvePathwayMcpToolId(spelling)).toBeNull();
    }
    expect(resolvePathwayMcpToolId("pathway_pathway_thread_read")).toBe("pathway_thread_read");
  });
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
      displayName: "Read a Pathway task",
      logo: "pathway",
    });
    expect(resolvePathwayMcpToolPresentation("mcp__pathway__issues_get_attachment")).toEqual({
      displayName: "Read a Pathway task attachment",
      logo: "pathway",
    });
    expect(resolvePathwayMcpToolPresentation("mcp__pathway__issues_comment_evidence")).toEqual({
      displayName: "Attach browser evidence to a Pathway task",
      logo: "pathway",
    });
    expect(resolvePathwayMcpToolPresentation("pathway.email_latest_code")).toEqual({
      displayName: "Get latest email code",
      logo: "pathway",
    });
    expect(resolvePathwayMcpToolPresentation("mcp__pathway__issues_get")).toEqual({
      displayName: "Read a Pathway task",
      logo: "pathway",
    });
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolvePathwayMcpToolPresentation("mcp__github__search_issues")).toBeNull();
  });
});
