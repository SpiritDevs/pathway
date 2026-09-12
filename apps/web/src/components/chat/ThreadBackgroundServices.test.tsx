import { expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RunId,
  ThreadId,
  TurnItemId,
  ProviderDriverKind,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { ThreadBackgroundServices } from "./ThreadBackgroundServices";
import { BackgroundServiceOutput } from "./BackgroundServiceOutput";

const item: OrchestrationV2TurnItem = {
  id: TurnItemId.make("item-background"),
  threadId: ThreadId.make("thread-background"),
  runId: RunId.make("run-background"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "task-background",
    strength: "strong",
  },
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
  type: "command_execution",
  input: "vp run dev",
  output: "Listening on port 3000",
};
const tasks = [
  { taskId: "task-background", description: "vp run dev", taskType: "command_execution" },
];

it("keeps the command to one collapsed line and output out of the palette", () => {
  const html = renderToStaticMarkup(
    <ThreadBackgroundServices
      tasks={tasks}
      turnItems={[item]}
      enabled
      onStop={async () => {}}
      onOpenOutput={() => {}}
    />,
  );
  expect(html).toContain("Background services");
  expect(html).toContain("Running");
  expect(html).not.toContain("Listening on port 3000");
  expect(html).not.toContain("Open output");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("truncate");
  expect(html).toContain('aria-label="Stop vp run dev"');
  expect(html).not.toContain(' disabled=""');
});

it("disables stop while disconnected or without a supported provider command", () => {
  for (const props of [
    { enabled: false, turnItems: [item] },
    { enabled: true, turnItems: [] },
  ]) {
    const html = renderToStaticMarkup(
      <ThreadBackgroundServices
        tasks={tasks}
        {...props}
        onStop={async () => {}}
        onOpenOutput={() => {}}
      />,
    );
    expect(html).toContain(' disabled=""');
  }
});

it("shows shared stop progress and actionable failure status", () => {
  for (const status of ["running", "failed"] as const) {
    const result: OrchestrationV2TurnItem = {
      ...item,
      id: TurnItemId.make("stop-result"),
      type: "run_interrupt_result",
      nativeItemRef: null,
      parentItemId: item.id,
      message: "Stop failed. Try again.",
      status,
    };
    const html = renderToStaticMarkup(
      <ThreadBackgroundServices
        tasks={tasks}
        turnItems={[item, result]}
        enabled
        onStop={async () => {}}
        onOpenOutput={() => {}}
      />,
    );
    if (status === "running") {
      expect(html).toContain("Stopping…");
      expect(html).toContain(' disabled=""');
    } else {
      expect(html).toContain('aria-label="Stop failed"');
      expect(html).not.toContain("Stop failed. Try again.");
      expect(html).not.toContain(' disabled=""');
    }
  }
});

it("shows readable output in the separate panel including the start of long logs", () => {
  const output = "FIRST LOG LINE\n" + "log line\n".repeat(2500) + "LAST LOG LINE";
  const html = renderToStaticMarkup(<BackgroundServiceOutput item={{ ...item, output }} />);
  expect(html).toContain('aria-label="Background service output"');
  expect(html).toContain("FIRST LOG LINE");
  expect(html).toContain("LAST LOG LINE");
});
