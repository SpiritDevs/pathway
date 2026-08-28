import { assert, it } from "@effect/vitest";
import {
  AttentionEventId,
  EnvironmentId,
  FocusProjectKey,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";

import { attentionTransitionForEvent, detectAttentionEventTransition } from "./AttentionEvents.ts";

const environmentId = EnvironmentId.make("environment:test");
const thread = {
  id: ThreadId.make("thread:test"),
  projectId: ProjectId.make("project:test"),
  settledAt: null,
} satisfies Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "settledAt">;

const event = (type: OrchestrationV2DomainEvent["type"], payload: Record<string, unknown>) =>
  ({
    id: `event:${type}`,
    type,
    threadId: thread.id,
    occurredAt: DateTime.makeUnsafe("2026-08-28T00:00:00.000Z"),
    payload,
  }) as OrchestrationV2DomainEvent;

it("detects each Attention Event from committed state transitions", () => {
  const transitions = [
    event("run.updated", { id: "run:completed", status: "completed" }),
    event("runtime-request.updated", {
      id: "request:approval",
      status: "pending",
      kind: "file-change",
    }),
    event("runtime-request.updated", {
      id: "request:input",
      status: "pending",
      kind: "user_input",
    }),
    event("run.updated", { id: "run:failed", status: "failed" }),
  ];

  assert.deepEqual(
    transitions.map((candidate) =>
      detectAttentionEventTransition({ environmentId, event: candidate, thread }),
    ),
    [
      {
        eventId: AttentionEventId.make(
          "attention:environment:test:thread:test:run:run:completed:finished-unsettled",
        ),
        threadId: thread.id,
        projectKey: FocusProjectKey.make("environment:test:project:test"),
        eventKind: "finished-unsettled",
      },
      {
        eventId: AttentionEventId.make(
          "attention:environment:test:thread:test:request:request:approval:pending-approval",
        ),
        threadId: thread.id,
        projectKey: FocusProjectKey.make("environment:test:project:test"),
        eventKind: "pending-approval",
      },
      {
        eventId: AttentionEventId.make(
          "attention:environment:test:thread:test:request:request:input:awaiting-input",
        ),
        threadId: thread.id,
        projectKey: FocusProjectKey.make("environment:test:project:test"),
        eventKind: "awaiting-input",
      },
      {
        eventId: AttentionEventId.make(
          "attention:environment:test:thread:test:run:run:failed:failed",
        ),
        threadId: thread.id,
        projectKey: FocusProjectKey.make("environment:test:project:test"),
        eventKind: "failed",
      },
    ],
  );
});

it("ignores non-transition updates and settled threads", () => {
  const ignored = [
    event("run.created", { id: "run:created", status: "completed" }),
    event("run.updated", { id: "run:running", status: "running" }),
    event("runtime-request.updated", {
      id: "request:resolved",
      status: "resolved",
      kind: "file-change",
    }),
    event("runtime-request.updated", {
      id: "request:auth",
      status: "pending",
      kind: "auth_refresh",
    }),
  ];

  assert.deepEqual(ignored.map(attentionTransitionForEvent), [null, null, null, null]);
  assert.isNull(
    detectAttentionEventTransition({
      environmentId,
      event: event("run.updated", { id: "run:settled", status: "completed" }),
      thread: {
        ...thread,
        settledAt: DateTime.makeUnsafe("2026-08-28T00:00:01.000Z"),
      },
    }),
  );
});

it("mints the same event id when a terminal transition is observed again", () => {
  const terminal = event("run.updated", { id: "run:stable", status: "failed" });
  const first = detectAttentionEventTransition({ environmentId, event: terminal, thread });
  const retry = detectAttentionEventTransition({ environmentId, event: terminal, thread });

  assert.equal(first?.eventId, retry?.eventId);
});

it("mints different event ids for the same transition in different environments", () => {
  const terminal = event("run.updated", { id: "run:stable", status: "failed" });
  const first = detectAttentionEventTransition({ environmentId, event: terminal, thread });
  const clone = detectAttentionEventTransition({
    environmentId: EnvironmentId.make("environment:clone"),
    event: terminal,
    thread,
  });

  assert.notEqual(first?.eventId, clone?.eventId);
});
