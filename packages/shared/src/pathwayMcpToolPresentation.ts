export type PathwayMcpToolLogo = "pathway";

export interface PathwayMcpToolPresentation {
  readonly displayName: string;
  readonly logo: PathwayMcpToolLogo;
}

// Legacy aliases keep persisted tool names from older Pathway releases presentable.
const PATHWAY_MCP_SERVER_ALIASES = new Set(["pathway", "pathway", "pathway_code", "pathway"]);

const PATHWAY_MCP_TOOL_DISPLAY_NAMES: Record<string, string> = {
  orchestrator_capabilities: "Get orchestration capabilities",
  delegate_task: "Delegate a child task",
  task_status: "Get delegated task status",
  task_cancel: "Cancel delegated task",
  schedule_task: "Schedule a recurring task",
  list_scheduled_tasks: "List scheduled tasks",
  update_scheduled_task: "Update a scheduled task",
  delete_scheduled_task: "Delete a scheduled task",
  create_threads: "Create Pathway threads",
  pathway_thread_start: "Start a Pathway thread",
  pathway_thread_list: "List Pathway threads",
  pathway_thread_read: "Read a Pathway thread",
  pathway_thread_send: "Send to a Pathway thread",
  pathway_thread_wait: "Wait for a Pathway thread",
  pathway_thread_interrupt: "Interrupt a Pathway thread",
  pathway_worktree_handoff: "Hand off thread to a git worktree",
  pathway_worktree_status: "Get thread worktree status",
  preview_status: "Get preview browser status",
  preview_open: "Open a page in the preview browser",
  preview_navigate: "Navigate the preview browser",
  preview_snapshot: "Snapshot the preview page",
  preview_click: "Click in the preview browser",
  preview_press: "Press a key in the preview browser",
  preview_type: "Type in the preview browser",
  preview_scroll: "Scroll the preview browser",
  preview_resize: "Resize the preview browser",
  preview_evaluate: "Evaluate script in the preview browser",
  preview_wait_for: "Wait for the preview page",
  preview_set_appearance: "Set preview browser appearance",
  preview_recording_start: "Start recording the preview browser",
  preview_recording_stop: "Stop recording the preview browser",
  issues_list: "List Pathway issues",
  issues_get: "Read a Pathway issue",
  issues_get_attachment: "Read a Pathway issue attachment",
  issues_create: "Create a Pathway issue",
  issues_update: "Update a Pathway issue",
  issues_comment: "Comment on a Pathway issue",
  issues_comment_evidence: "Attach browser evidence to a Pathway issue",
  issues_delete: "Delete a Pathway issue",
  issues_restore: "Restore a Pathway issue",
  issues_link_thread: "Link a thread to a Pathway issue",
  email_wait_for: "Wait for captured email",
  email_latest_code: "Get latest email code",
  email_list: "List captured email",
  email_get: "Read captured email",
};

function normalizePathwayMcpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function resolvePathwayMcpToolName(value: string): string | null {
  const label = normalizePathwayMcpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      PATHWAY_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch = /^(?<server>pathway|pathway|pathway_code|pathway)[.:/](?<tool>.+)$/i.exec(
    label,
  );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  return Object.hasOwn(PATHWAY_MCP_TOOL_DISPLAY_NAMES, label) ? label : null;
}

export function resolvePathwayMcpToolPresentation(
  toolName: string | null | undefined,
): PathwayMcpToolPresentation | null {
  const resolvedToolName =
    toolName === undefined || toolName === null ? null : resolvePathwayMcpToolName(toolName);
  if (resolvedToolName === null) return null;
  const displayName = PATHWAY_MCP_TOOL_DISPLAY_NAMES[resolvedToolName];
  return displayName === undefined ? null : { displayName, logo: "pathway" };
}
