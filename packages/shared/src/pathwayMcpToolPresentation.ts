export type PathwayMcpToolLogo = "pathway";

export interface PathwayMcpToolPresentation {
  readonly displayName: string;
  readonly logo: PathwayMcpToolLogo;
}

// Legacy aliases keep persisted tool names from older Pathway releases presentable.
const PATHWAY_MCP_SERVER_ALIASES = new Set(["pathway", "pathway", "pathway_code", "pathway"]);

const PATHWAY_MCP_TOOL_DISPLAY_NAMES: Record<string, string> = {
  orchestrator_capabilities: "Get orchestration capabilities",
  pathway_environments_list: "List Pathway environments",
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
  pathway_thread_set_parent: "Move a Pathway thread",
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
  issues_list: "List Pathway tasks",
  issues_get: "Read a Pathway task",
  issues_get_attachment: "Read a Pathway task attachment",
  issues_create: "Create a Pathway task",
  issues_update: "Update a Pathway task",
  issues_comment: "Comment on a Pathway task",
  issues_comment_evidence: "Attach browser evidence to a Pathway task",
  issues_delete: "Delete a Pathway task",
  issues_restore: "Restore a Pathway task",
  issues_link_thread: "Link a thread to a Pathway task",
  issues_unlink_thread: "Unlink a thread from a Pathway task",
  issues_comment_update: "Edit a Pathway task comment",
  issues_comment_delete: "Delete a Pathway task comment",
  issues_todo_create: "Add a Pathway checklist item",
  issues_todo_update: "Update a Pathway checklist item",
  issues_todo_delete: "Remove a Pathway checklist item",
  issues_todos_reorder: "Reorder a Pathway checklist",
  issues_relation_create: "Link Pathway tasks",
  issues_relation_delete: "Unlink Pathway tasks",
  issues_history: "Read a Pathway task's history",
  issues_triage_accept: "Accept a Pathway triage item",
  issues_triage_reject: "Reject a Pathway triage item",
  issues_milestones_list: "List Pathway milestones",
  issues_milestone_create: "Create a Pathway milestone",
  issues_milestone_update: "Update a Pathway milestone",
  issues_milestone_delete: "Delete a Pathway milestone",
  issues_milestones_reorder: "Reorder Pathway milestones",
  issues_milestone_history: "Read a Pathway milestone burn-up",
  issues_cycles_list: "List Pathway cycles",
  issues_cycle_create: "Create a Pathway cycle",
  issues_cycle_update: "Update a Pathway cycle",
  issues_cycle_delete: "Delete a Pathway cycle",
  issues_members_list: "List Pathway members",
  issues_labels_list: "List Pathway labels",
  issues_label_create: "Create a Pathway label",
  issues_label_update: "Update a Pathway label",
  issues_label_delete: "Delete a Pathway label",
  issues_statuses_list: "List Pathway statuses",
  issues_status_create: "Create a Pathway status",
  issues_status_update: "Update a Pathway status",
  issues_status_delete: "Delete a Pathway status",
  issues_statuses_reorder: "Reorder Pathway statuses",
  projects_list: "List Pathway projects",
  projects_update: "Update a Pathway project",
  projects_set_icon: "Set a Pathway project icon",
  email_wait_for: "Wait for captured email",
  email_latest_code: "Get latest email code",
  email_list: "List captured email",
  email_get: "Read captured email",
  html_preview: "Preview an HTML page",
  html_render: "Render an HTML page",
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

  // OpenCode joins the stable server name and tool with one underscore.
  // Match a complete known id, never an arbitrary other-server suffix.
  for (const server of PATHWAY_MCP_SERVER_ALIASES) {
    if (label.toLowerCase().startsWith(`${server}_`)) {
      const tool = label.slice(server.length + 1);
      if (Object.hasOwn(PATHWAY_MCP_TOOL_DISPLAY_NAMES, tool)) return tool;
    }
  }

  return Object.hasOwn(PATHWAY_MCP_TOOL_DISPLAY_NAMES, label) ? label : null;
}

/** The bare tool id for a known Pathway MCP spelling. */
export function resolvePathwayMcpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolvePathwayMcpToolName(toolName);
  return name !== null && Object.hasOwn(PATHWAY_MCP_TOOL_DISPLAY_NAMES, name) ? name : null;
}

export function resolvePathwayMcpToolPresentation(
  toolName: string | null | undefined,
): PathwayMcpToolPresentation | null {
  const resolvedToolName = resolvePathwayMcpToolId(toolName);
  if (resolvedToolName === null) return null;
  const displayName = PATHWAY_MCP_TOOL_DISPLAY_NAMES[resolvedToolName];
  return displayName === undefined ? null : { displayName, logo: "pathway" };
}
