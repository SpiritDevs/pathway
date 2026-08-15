import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
}));

vi.mock("@spiritdevs/client-runtime/environment", () => ({
  scopeThreadRef: () => ({}) as never,
}));

// Only the projection-derived state is faked; the ordering helpers under test
// stay real so the rendered queue and the reorder contract agree.
vi.mock("@spiritdevs/client-runtime/state/thread-workflows", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  deriveThreadQueueWorkflowState: () => state.workflow,
}));

vi.mock("../../state/entities", () => ({
  useThreadProjection: () => state.projection,
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    cancelQueuedRun: Symbol("cancelQueuedRun"),
    editQueuedRun: Symbol("editQueuedRun"),
    promoteQueuedRun: Symbol("promoteQueuedRun"),
    reorderQueuedRun: Symbol("reorderQueuedRun"),
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

import { QueuedRunsControl } from "./QueuedRunsControl";

const queuedRun = (id: string, text: string, createdBy: "user" | "agent" = "user") => ({
  run: { id: `run:${id}`, userMessageId: `message:${id}` },
  text,
  createdBy,
});

const render = (optimisticMessages: ReadonlyArray<unknown> = []) =>
  renderToStaticMarkup(
    <QueuedRunsControl
      environmentId={"environment:test" as never}
      optimisticMessages={optimisticMessages as never}
      threadId={"thread:test" as never}
    />,
  );

/** The queue as a reader sees it: each row's position label and its message text. */
const renderedRows = (html: string) =>
  html
    .split("<li")
    .slice(1)
    .map((row) => ({
      position: /tabular-nums[^"]*">(\d+)</.exec(row)?.[1],
      text: /title="([^"]+)"/.exec(row)?.[1],
    }));

const setQueue = (input: {
  readonly canReorder?: boolean;
  readonly projectedMessageIds?: ReadonlyArray<string>;
  readonly queuedRuns: ReadonlyArray<ReturnType<typeof queuedRun>>;
}) => {
  state.projection = {
    projection: {
      messages: (input.projectedMessageIds ?? []).map((id) => ({ id })),
    },
  };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: input.canReorder ?? true,
    queuedRuns: input.queuedRuns,
  };
};

describe("QueuedRunsControl sorting", () => {
  it("gives every committed row a drag handle and drops the arrow buttons", () => {
    setQueue({
      queuedRuns: [
        queuedRun("first", "First message"),
        queuedRun("second", "Second message"),
        queuedRun("third", "Third message"),
      ],
    });

    const html = render();

    expect(html).not.toContain("Move queued message up");
    expect(html).not.toContain("Move queued message down");
    expect(html).toContain("Reorder queued message 1 of 3: First message");
    expect(html).toContain("Reorder queued message 2 of 3: Second message");
    expect(html).toContain("Reorder queued message 3 of 3: Third message");
    // The handle announces the row it moves, and stays out of the way of a
    // touch scroll until it is the thing being touched.
    expect(html).toContain("touch-none");
  });

  it("numbers rows by display order, top row first", () => {
    setQueue({
      queuedRuns: [queuedRun("first", "First message"), queuedRun("second", "Second message")],
    });

    expect(renderedRows(render())).toEqual([
      { position: "1", text: "First message" },
      { position: "2", text: "Second message" },
    ]);
  });

  it("keeps edit, steer and remove alongside the handle", () => {
    setQueue({
      queuedRuns: [queuedRun("first", "First message"), queuedRun("second", "Second message")],
    });

    const html = render();

    expect(html).toContain("Edit queued message");
    expect(html).toContain("Steer");
    expect(html).toContain("Remove queued message");
  });

  it("offers no handles when the provider cannot reorder its queue", () => {
    setQueue({
      canReorder: false,
      queuedRuns: [queuedRun("first", "First message"), queuedRun("second", "Second message")],
    });

    const html = render();

    expect(html).not.toContain("Reorder queued message");
    expect(html).toContain("First message");
    expect(html).toContain("Remove queued message");
  });

  it("offers no handle for a queue of one, which cannot move", () => {
    setQueue({ queuedRuns: [queuedRun("only", "Only message")] });

    const html = render();

    expect(html).not.toContain("Reorder queued message");
    expect(html).toContain("Only message");
  });

  it("shows a message still being saved after the committed runs, without a handle", () => {
    setQueue({
      queuedRuns: [queuedRun("first", "First message"), queuedRun("second", "Second message")],
    });

    const html = render([
      { id: "message:pending", inputIntent: "queued_turn", text: "Pending message" },
    ]);

    expect(html).toContain("Saving queued message");
    expect(html).toContain("Reorder queued message 1 of 2: First message");
    expect(html).not.toContain("Reorder queued message 3");
    expect(renderedRows(html)).toEqual([
      { position: "1", text: "First message" },
      { position: "2", text: "Second message" },
      { position: "3", text: "Pending message" },
    ]);
    expect(html).toContain("3 queued messages");
  });

  it("does not resurrect a cancelled server-owned message as an optimistic save", () => {
    setQueue({
      projectedMessageIds: ["message:cancelled"],
      queuedRuns: [queuedRun("remaining", "Remaining message")],
    });

    const html = render([
      { id: "message:cancelled", inputIntent: "queued_turn", text: "Cancelled message" },
    ]);

    expect(html).not.toContain("Cancelled message");
    expect(html).not.toContain("Saving queued message");
    expect(renderedRows(html)).toEqual([{ position: "1", text: "Remaining message" }]);
  });
});

describe("QueuedRunsControl agent attribution", () => {
  it("badges agent-queued rows and withholds their edit and steer affordances", () => {
    setQueue({
      queuedRuns: [
        queuedRun("wake", "Background command completed (exit 1): sleep 5", "agent"),
        queuedRun("typed", "Typed by the user"),
      ],
    });

    const html = render();

    expect(html).toContain("Queued automatically by an agent");
    expect(html).toContain(">Agent<");
    expect(html).toContain("Agent-queued messages cannot be edited");
    expect(html).toContain("Agent-queued messages cannot be sent as a steer");
    // The user's own row keeps the live steer affordance.
    expect(html).toContain("Send as a steer instead");
  });
});

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", () => {
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: "run:parent",
              generation: 1,
              taskIds: ["task:child"],
            },
            id: "message:completion",
          },
        ],
      },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    expect(render()).toBe("");
  });
});
