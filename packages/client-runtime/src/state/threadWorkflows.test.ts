import { describe, expect, it } from "vite-plus/test";

import {
  canDetachThreadProviderSession,
  canForkProjectedAssistantItem,
  deriveThreadQueueWorkflowState,
  isQueuedRunOrderStale,
  orderQueuedRuns,
  resolveLatestMergeBackRun,
  resolveQueuedRunReorder,
} from "./threadWorkflows.ts";

const capabilities = (input?: {
  readonly queued?: boolean;
  readonly steer?: boolean;
  readonly restartSteer?: boolean;
  readonly nativeFork?: boolean;
  readonly portableFork?: boolean;
}) =>
  ({
    turns: {
      supportsQueuedMessages: input?.queued ?? false,
      supportsActiveSteering: input?.steer ?? false,
      supportsSteeringByInterruptRestart: input?.restartSteer ?? false,
    },
    threads: {
      canForkThread: input?.nativeFork ?? false,
      canForkFromTurn: input?.nativeFork ?? false,
    },
    identity: { nativeThreadIds: input?.nativeFork ? "strong" : "none" },
    context: { supportsFullThreadHandoff: input?.portableFork ?? false },
  }) as never;

describe("thread workflows", () => {
  it("sorts queued messages and gates reorder and promotion from capabilities", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "later", status: "queued", userMessageId: "message-later", ordinal: 3 },
        {
          id: "first",
          status: "queued",
          userMessageId: "message-first",
          ordinal: 2,
          queuePosition: 1,
        },
      ],
      messages: [
        { id: "message-first", text: "First" },
        { id: "message-later", text: "Later" },
      ],
      providerTurns: [
        {
          id: "provider-turn-active",
          runAttemptId: "attempt-active",
          status: "running",
        },
      ],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, restartSteer: true }),
        },
      ],
    } as never);

    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["first", "First"],
      ["later", "Later"],
    ]);
    expect(state.activeRun?.id).toBe("active");
    expect(state.canReorder).toBe(true);
    expect(state.canPromoteToSteer).toBe(true);
  });

  it("hides automatic completion delivery from the visible queue", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: null },
      runs: [
        {
          id: "automatic",
          status: "queued",
          userMessageId: "message-automatic",
          ordinal: 2,
          queuePosition: 1,
        },
        {
          id: "visible",
          status: "queued",
          userMessageId: "message-visible",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        {
          id: "message-automatic",
          text: "A delegated task reached a terminal state.",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message-visible", text: "Visible queued message" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["visible", "Visible queued message"],
    ]);
  });

  it("attributes provider continuation wakes to the agent that queued them", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: null },
      runs: [
        { id: "wake", status: "queued", userMessageId: "message-wake", ordinal: 2 },
        { id: "typed", status: "queued", userMessageId: "message-typed", ordinal: 3 },
      ],
      messages: [
        {
          id: "message-wake",
          text: "Background command completed (exit 1): sleep 5",
          createdBy: "agent",
        },
        { id: "message-typed", text: "Typed by the user", createdBy: "user" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.queuedRuns.map(({ run, createdBy }) => [run.id, createdBy])).toEqual([
      ["wake", "agent"],
      ["typed", "user"],
    ]);
  });

  it("removes only the promoted head from the visible queue", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "promoted",
          status: "starting",
          userMessageId: "message-promoted",
          providerThreadId: "provider-thread",
          ordinal: 2,
          queuePosition: null,
        },
        {
          id: "still-queued",
          status: "queued",
          userMessageId: "message-still-queued",
          providerThreadId: "provider-thread",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        { id: "message-promoted", text: "Run now" },
        { id: "message-still-queued", text: "Wait longer" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.activeRun?.id).toBe("promoted");
    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["still-queued", "Wait longer"],
    ]);
  });

  it.each(["preparing", "starting", "waiting"] as const)(
    "does not promote queued work into a %s run",
    (status) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: "provider-thread" },
        runs: [
          {
            id: "active",
            status,
            providerThreadId: "provider-thread",
            activeAttemptId: "attempt-active",
            ordinal: 1,
          },
          { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
        ],
        messages: [{ id: "message", text: "Queued" }],
        providerTurns: [
          {
            id: "provider-turn-active",
            runAttemptId: "attempt-active",
            status: status === "waiting" ? "completed" : "starting",
          },
        ],
        providerThreads: [
          {
            id: "provider-thread",
            appThreadId: "thread",
            providerSessionId: "provider-session",
          },
        ],
        providerSessions: [
          {
            id: "provider-session",
            status: "running",
            capabilities: capabilities({ queued: true, steer: true }),
          },
        ],
      } as never);

      expect(state.canPromoteToSteer).toBe(false);
    },
  );

  it("does not promote queued work until the running provider turn is projected", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
      ],
      messages: [{ id: "message", text: "Queued" }],
      providerTurns: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, steer: true }),
        },
      ],
    } as never);

    expect(state.canPromoteToSteer).toBe(false);
  });

  it("does not expose known unsupported queue or fork actions", () => {
    const projection = {
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [{ id: "queued", status: "queued", userMessageId: "message", ordinal: 1 }],
      messages: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "ready",
          capabilities: capabilities(),
        },
      ],
    } as never;
    const queue = deriveThreadQueueWorkflowState(projection);
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(queue.canReorder).toBe(false);
    expect(queue.canPromoteToSteer).toBe(false);
    expect(canForkProjectedAssistantItem({ projectedItem, capabilities: capabilities() })).toBe(
      false,
    );
    expect(canDetachThreadProviderSession(projection)).toBe(true);
  });

  it("allows native, portable, and capability-unknown exact-run forks", () => {
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ nativeFork: true }),
      }),
    ).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ portableFork: true }),
      }),
    ).toBe(true);
    expect(canForkProjectedAssistantItem({ projectedItem })).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem: {
          item: { type: "assistant_message", runId: "run", status: "running" },
        } as never,
      }),
    ).toBe(false);
  });

  it("merges the newest provider-finished run while checkpoint capture is pending", () => {
    const projection = {
      runs: [
        { id: "newest-queued", status: "queued", ordinal: 3 },
        { id: "older-completed", status: "completed", ordinal: 1 },
        { id: "newest-finished", status: "waiting", ordinal: 2 },
      ],
    } as never;

    expect(resolveLatestMergeBackRun(projection)?.id).toBe("newest-finished");
  });

  it("does not let a stale completed run later in storage order hide the waiting checkpoint", () => {
    const projection = {
      runs: [
        { id: "newest-finished", status: "waiting", ordinal: 2 },
        { id: "older-completed", status: "completed", ordinal: 1 },
      ],
    } as never;

    expect(resolveLatestMergeBackRun(projection)?.id).toBe("newest-finished");
  });

  it.each(["preparing", "starting", "running"] as const)(
    "does not merge older history while a newer run is %s",
    (status) => {
      const projection = {
        runs: [
          { id: "older-completed", status: "completed", ordinal: 1 },
          { id: "newer-active", status, ordinal: 2 },
        ],
      } as never;

      expect(resolveLatestMergeBackRun(projection)).toBeNull();
    },
  );
});

const queuedRun = (id: string) => ({ run: { id }, text: `message ${id}` }) as never;

describe("queued run ordering", () => {
  it("moves a run onto its neighbour and points the command at the run that follows", () => {
    expect(
      resolveQueuedRunReorder({
        orderedRunIds: ["a", "b", "c"] as never,
        activeRunId: "a" as never,
        overRunId: "b" as never,
      }),
    ).toEqual({ runId: "a", beforeRunId: "c", order: ["b", "a", "c"] });
  });

  it("moves a middle run to the top in one drag", () => {
    expect(
      resolveQueuedRunReorder({
        orderedRunIds: ["a", "b", "c", "d"] as never,
        activeRunId: "c" as never,
        overRunId: "a" as never,
      }),
    ).toEqual({ runId: "c", beforeRunId: "a", order: ["c", "a", "b", "d"] });
  });

  it("targets the bottom with a null before-run", () => {
    expect(
      resolveQueuedRunReorder({
        orderedRunIds: ["a", "b", "c", "d"] as never,
        activeRunId: "b" as never,
        overRunId: "d" as never,
      }),
    ).toEqual({ runId: "b", beforeRunId: null, order: ["a", "c", "d", "b"] });
  });

  it("sends nothing for a drop back onto the original slot or an unknown target", () => {
    expect(
      resolveQueuedRunReorder({
        orderedRunIds: ["a", "b"] as never,
        activeRunId: "a" as never,
        overRunId: "a" as never,
      }),
    ).toBeNull();
    expect(
      resolveQueuedRunReorder({
        orderedRunIds: ["a", "b"] as never,
        activeRunId: "a" as never,
        overRunId: "gone" as never,
      }),
    ).toBeNull();
  });

  it("shows the dragged order and ignores one that no longer describes the queue", () => {
    const queued = [queuedRun("a"), queuedRun("b"), queuedRun("c")];

    expect(orderQueuedRuns(queued, ["c", "a", "b"] as never).map(({ run }) => run.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(orderQueuedRuns(queued, null).map(({ run }) => run.id)).toEqual(["a", "b", "c"]);
    // The run that was dragged started, so the projection wins.
    expect(
      orderQueuedRuns([queuedRun("b"), queuedRun("c")], ["c", "a", "b"] as never),
    ).toHaveLength(2);
    expect(orderQueuedRuns(queued, ["c", "a", "d"] as never).map(({ run }) => run.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("releases the dragged order once the projection confirms it or the queue moves on", () => {
    // The drag moved "c" to the top against a projection that still reads a, b, c.
    const dragged = { order: ["c", "a", "b"], baselineRunIds: ["a", "b", "c"] } as never as {
      order: ReadonlyArray<never>;
      baselineRunIds: ReadonlyArray<never>;
    };

    // Confirmed by the projection.
    expect(isQueuedRunOrderStale({ ...dragged, serverRunIds: ["c", "a", "b"] as never })).toBe(
      true,
    );
    // The projection has not caught up yet: keep showing the drag.
    expect(isQueuedRunOrderStale({ ...dragged, serverRunIds: ["a", "b", "c"] as never })).toBe(
      false,
    );
    // A run left the queue, or a new one arrived.
    expect(isQueuedRunOrderStale({ ...dragged, serverRunIds: ["a", "b"] as never })).toBe(true);
    expect(isQueuedRunOrderStale({ ...dragged, serverRunIds: ["a", "b", "d"] as never })).toBe(
      true,
    );
    // Another device reordered first: the server's order wins over the drag.
    expect(isQueuedRunOrderStale({ ...dragged, serverRunIds: ["b", "a", "c"] as never })).toBe(
      true,
    );
  });
});
