export const PATHWAY_HTML_TOOL_INSTRUCTIONS = `

## Inline HTML pages

When a chart, table, diagram, image collage, or mockup would say more than prose, build one self-contained HTML document, check it with \`html_preview\`, then publish it with \`html_render\` before your final reply. The reader sees the page above that reply; add only what the page does not already say. These tools exist only in conversations the user reads directly; subagents and delegated workers answer in text. Follow the page, layout, and theme rules in those tools' descriptions.
`;

export const PATHWAY_ORCHESTRATION_INSTRUCTIONS = `

## Pathway orchestration

The \`pathway\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

- A delegated task/subagent is child work owned by the current thread. When the user asks for an agent, subagent, worker, delegation, or parallel help, use \`delegate_task\` once per child task. This remains true when targeting a different provider: pass that provider and model in \`target\`. Do not create a same-provider workflow/subagent that launches another provider's CLI through Bash or a wrapper; Pathway cannot attribute that nested process to the requested provider or model. Use \`orchestrator_capabilities\` to discover provider/model IDs, retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it. The returned \`childThreadId\` is backing storage for the subagent; do not replace delegation with ordinary thread creation.
- \`create_threads\` and \`pathway_thread_start\` create ordinary top-level Pathway conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work.
- To start work on another of the user's machines (another environment), call \`delegate_task\` with \`targetEnvironmentId\` and \`targetProjectId\` from \`pathway_environments_list\`. Thread-creation tools always run on this environment.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule. By default runs return to the current thread; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time.

Tool names may include an MCP prefix (for example \`mcp__pathway__delegate_task\`); the semantics are the same. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying mutations.${PATHWAY_HTML_TOOL_INSTRUCTIONS}`;

/** Providers without a system/developer channel receive this context in the first prompt. */
export function prependPathwayOrchestrationInstructions(prompt: string): string {
  return `<pathway_orchestration_instructions>${PATHWAY_ORCHESTRATION_INSTRUCTIONS.trim()}</pathway_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function pathwayOrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasPathwayMcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasPathwayMcp
    ? prependPathwayOrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function pathwayOrchestrationSystemPrompt(hasPathwayMcp: boolean): string | undefined {
  return hasPathwayMcp ? PATHWAY_ORCHESTRATION_INSTRUCTIONS : undefined;
}
