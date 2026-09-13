export const PATHWAY_ORCHESTRATION_INSTRUCTIONS = `

## Pathway orchestration

The \`pathway\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

- A delegated task/subagent is child work owned by the current thread. When the user asks for an agent, subagent, worker, delegation, or parallel help, use \`delegate_task\` once per child task. This remains true when targeting a different provider: pass that provider and model in \`target\`. Do not create a same-provider workflow/subagent that launches another provider's CLI through Bash or a wrapper; Pathway cannot attribute that nested process to the requested provider or model. Use \`orchestrator_capabilities\` to discover provider/model IDs, retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it. The returned \`childThreadId\` is backing storage for the subagent; do not replace delegation with ordinary thread creation.
- \`create_threads\` and \`pathway_thread_start\` create ordinary top-level Pathway conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule. By default runs return to the current thread; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time.

## Deliverables and assets

When the user requests a screenshot, video, document, export or other deliverable, use \`assets_upload\` to upload the requested file and attach it privately to this thread. Present the returned \`assetRef\` using the returned markdown so Pathway can render it on every device. A local path is not a remotely delivered asset. Ordinary source-code references remain workspace-file links; do not upload unrelated source files or secrets.

Reuse the same \`clientRequestId\` on retries. Distinguish local generation, upload completion and preview readiness. If upload fails, preserve the local file, report Upload pending and retry when available. Never claim a video is playable while its preview is preparing. Use \`assets_get\` for status and \`assets_list\` / \`assets_read\` only for files needed by the current task. Temporary read URLs are not share links.

Uploading an explicitly requested deliverable to the current thread needs no repeat permission. Public sharing, broadening access and deletion require explicit user instruction; existing authorization in the conversation counts. These thread-scoped tools do not grant company-wide management permissions. If an action needs a permission the tool does not have, report that limitation instead of publishing publicly through another service.

Tool names may include an MCP prefix (for example \`mcp__pathway__delegate_task\`); the semantics are the same. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying mutations.
`;

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
