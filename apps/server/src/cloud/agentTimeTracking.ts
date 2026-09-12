import type { OrchestrationV2DomainEvent } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const AgentTimeSession = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  localProjectId: Schema.String,
  description: Schema.String,
  title: Schema.optionalKey(Schema.String),
  summaryComplete: Schema.optionalKey(Schema.Boolean),
  summaryRetryAt: Schema.optionalKey(Schema.Number),
  startedAt: Schema.String,
  stoppedAt: Schema.NullOr(Schema.String),
  state: Schema.Literals(["running", "paused", "stopped"]),
  intervals: Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number })),
  runningSince: Schema.NullOr(Schema.Number),
  observedAt: Schema.Number,
  revision: Schema.Number,
  runStatus: Schema.String,
  blockedRequestIds: Schema.Array(Schema.String),
});
export type AgentTimeSession = typeof AgentTimeSession.Type;

const terminalStatuses = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export function transitionAgentTimeSession(
  current: AgentTimeSession,
  state: AgentTimeSession["state"],
  at: number,
): AgentTimeSession {
  const timestamp = Math.max(at, current.observedAt);
  const runningSince = current.runningSince;
  return {
    ...current,
    state,
    intervals:
      runningSince !== null && state !== "running" && timestamp > runningSince
        ? [...current.intervals, { start: runningSince, end: timestamp }]
        : current.intervals,
    runningSince: state === "running" ? (current.runningSince ?? timestamp) : null,
    stoppedAt: state === "stopped" ? DateTime.formatIso(DateTime.makeUnsafe(timestamp)) : null,
    observedAt: timestamp,
    revision: current.revision + 1,
  };
}

/** Each durable run owns its own clock. Native subagent nodes do not create extra clocks. */
export function applyAgentTimeEvent(
  current: AgentTimeSession | null,
  event: OrchestrationV2DomainEvent,
  project: { readonly id: string; readonly title: string },
): AgentTimeSession | null {
  const at = DateTime.toEpochMillis(event.occurredAt);
  if (event.type === "run.created" || event.type === "run.updated") {
    const run = event.payload;
    if (current === null && event.type !== "run.created") return null;
    const session: AgentTimeSession = current ?? {
      id: run.id,
      threadId: event.threadId,
      localProjectId: project.id,
      description: project.title,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
      stoppedAt: null,
      state: "paused",
      intervals: [],
      runningSince: null,
      observedAt: at,
      revision: 0,
      runStatus: run.status,
      blockedRequestIds: [],
    };
    const next = { ...session, runStatus: run.status };
    return transitionAgentTimeSession(
      next,
      terminalStatuses.has(run.status)
        ? "stopped"
        : run.status === "running" && next.blockedRequestIds.length === 0
          ? "running"
          : "paused",
      at,
    );
  }
  if (current === null || current.state === "stopped") return current;
  if (event.type === "thread.deleted") {
    return transitionAgentTimeSession(current, "stopped", at);
  }
  if (event.type !== "runtime-request.updated") return current;
  const request = event.payload;
  const blocked = new Set(current.blockedRequestIds);
  if (
    request.status === "pending" &&
    request.isBlocking !== false &&
    request.kind !== "dynamic_tool_call"
  )
    blocked.add(request.id);
  else blocked.delete(request.id);
  const next = { ...current, blockedRequestIds: [...blocked] };
  return transitionAgentTimeSession(
    next,
    next.runStatus === "running" && blocked.size === 0 ? "running" : "paused",
    at,
  );
}

export function agentTimeSessionPayload(session: AgentTimeSession) {
  const {
    blockedRequestIds: _blockedRequestIds,
    summaryComplete: _summaryComplete,
    summaryRetryAt: _summaryRetryAt,
    ...payload
  } = session;
  return payload;
}
