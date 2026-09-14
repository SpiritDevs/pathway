import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";

/** Small, bounded reads performed by the coordinator without creating a worker thread. */
export const OrchestratorInspection = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("readThread"),
    threadId: Schema.String,
    beforeMessageId: Schema.optionalKey(Schema.String),
    messageId: Schema.optionalKey(Schema.String),
    startCharacter: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("readFile"),
    path: Schema.String,
    startLine: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ kind: Schema.Literal("listFiles"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("webSearch"), query: Schema.String }),
]);
export type OrchestratorInspection = typeof OrchestratorInspection.Type;
export const OrchestratorPendingInspection = Schema.Struct({
  id: Schema.String,
  chatId: Schema.String,
  localProjectId: Schema.NullOr(Schema.String),
  request: OrchestratorInspection,
  selection: ModelSelection,
});
export type OrchestratorPendingInspection = typeof OrchestratorPendingInspection.Type;

export const ORCHESTRATOR_REPORT_LIMIT = 32000;
export const ORCHESTRATOR_WORKER_REPORT_INSTRUCTIONS = `

<orchestrator_handoff>
Your final answer is automatically delivered to the assigning orchestrator. It cannot see your intermediate tool calls. Return a self-contained factual handoff with:
- Outcome: what was requested, what you found or changed, and whether it is complete, blocked, or partial.
- Evidence: concrete findings and relevant file paths/line references or source URLs; distinguish observations from assumptions.
- Changes and artifacts: files changed, repository/worktree, branch, commit IDs, PR URLs and other outputs where applicable. Say explicitly whether work was committed, pushed, or deployed.
- Verification: checks/tests actually run and their results; disclose anything unverified or failing.
- Remaining work: blockers, caveats, decisions needed and exact next steps, or none.
Include essential details from any subagents you used. Keep this report under 24,000 characters, put the outcome first, and omit sections that do not apply. Do not include private reasoning, credentials, or raw tool logs. Do not say only "done" or require the orchestrator to ask what you did. This reporting requirement does not authorize additional changes or expand the assignment.
</orchestrator_handoff>`;
