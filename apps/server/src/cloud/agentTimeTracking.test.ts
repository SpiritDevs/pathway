import * as fixtures from "./agentTimeTracking.testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import { OrchestrationV2DomainEventJson } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { applyAgentTimeEvent, type AgentTimeSession } from "./agentTimeTracking.ts";

const decode = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const project = { id: "project-1", title: "Build the feature" };
const { timestamp, runEvent } = fixtures;
const requestEvent = (status: string, seconds: number, isBlocking = true, id = "request-1") =>
  decode({
    id: `event-request-${seconds}`,
    threadId: "thread-1",
    runId: "run-1",
    type: "runtime-request.updated",
    occurredAt: timestamp(seconds),
    payload: {
      id,
      nodeId: "node-1",
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status,
      isBlocking,
      responseCapability: { type: "not_resumable", reason: "test" },
      createdAt: timestamp(seconds),
      resolvedAt: status === "resolved" ? timestamp(seconds) : null,
    },
  });
const secondsTracked = (session: AgentTimeSession) =>
  session.intervals.reduce((sum, item) => sum + item.end - item.start, 0) / 1000;
const apply = (session: AgentTimeSession | null, event: ReturnType<typeof decode>) =>
  applyAgentTimeEvent(session, event, project)!;

describe("agent time lifecycle", () => {
  it("starts with work, pauses blocking input and resumes only when all blockers resolve", () => {
    let session = apply(null, runEvent("queued", 0, "run.created"));
    session = apply(session, runEvent("running", 10));
    session = apply(session, requestEvent("pending", 40));
    session = apply(session, requestEvent("pending", 45, true, "request-2"));
    session = apply(session, requestEvent("resolved", 60));
    expect(session.state).toBe("paused");
    session = apply(session, requestEvent("resolved", 70, true, "request-2"));
    session = apply(session, runEvent("completed", 100));
    expect(secondsTracked(session)).toBe(60);
    expect(session.state).toBe("stopped");
  });

  it("keeps working through non-blocking questions", () => {
    let session = apply(null, runEvent("running", 0, "run.created"));
    session = apply(session, requestEvent("pending", 20, false));
    expect(session.state).toBe("running");
    session = apply(session, runEvent("completed", 60));
    expect(secondsTracked(session)).toBe(60);
  });

  it.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"])(
    "closes a %s run without duplicating time on redelivery",
    (status) => {
      let session = apply(null, runEvent("running", 0, "run.created"));
      session = apply(session, runEvent(status, 30));
      session = apply(session, runEvent(status, 30));
      expect(secondsTracked(session)).toBe(30);
      expect(session.runningSince).toBeNull();
    },
  );

  it("adds eight concurrent runs independently", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => {
      const id = `run-${index}`;
      return apply(
        apply(null, runEvent("running", 0, "run.created", id)),
        runEvent("completed", 1800, "run.updated", id),
      );
    });
    expect(sessions.reduce((sum, session) => sum + secondsTracked(session), 0)).toBe(4 * 3600);
  });

  it("does not infer a new session from a historical run update", () => {
    expect(applyAgentTimeEvent(null, runEvent("running", 10), project)).toBeNull();
  });
});
