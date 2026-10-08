import * as DateTime from "effect/DateTime";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type ServerProviderModel,
} from "@spiritdevs/contracts";
import { createModelSelection } from "@spiritdevs/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveSubagentBarStatus,
  describeSubagentModel,
  formatSubagentBarStatus,
} from "./SubagentComposerBar.logic";

const STARTED = "2026-10-08T10:00:00.000Z";
const COMPLETED = "2026-10-08T10:08:01.000Z";

function rootTurn(
  overrides: Partial<Pick<OrchestrationV2ExecutionNode, "status" | "runId" | "completedAt">>,
): OrchestrationV2ExecutionNode {
  const id = NodeId.make("node-root");
  return {
    id,
    threadId: ThreadId.make("thread-child"),
    runId: null,
    parentNodeId: null,
    rootNodeId: id,
    kind: "root_turn",
    status: "running",
    countsForRun: true,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: DateTime.makeUnsafe(STARTED),
    completedAt: null,
    ...overrides,
  };
}

describe("deriveSubagentBarStatus", () => {
  it("prefers the child's own run", () => {
    expect(
      deriveSubagentBarStatus({
        run: { status: "running", startedAt: STARTED, completedAt: null },
        nodes: [rootTurn({ status: "completed" })],
      }),
    ).toEqual({ phase: "working", startedAt: STARTED, completedAt: null });
  });

  it("reads a provider-native subagent from its runless root turn", () => {
    expect(
      deriveSubagentBarStatus({
        run: null,
        nodes: [
          rootTurn({ status: "completed", completedAt: DateTime.makeUnsafe(COMPLETED) }),
          rootTurn({ status: "running", runId: RunId.make("run-1") }),
        ],
      }),
    ).toEqual({ phase: "completed", startedAt: STARTED, completedAt: COMPLETED });
  });

  it("is unknown before any work arrives", () => {
    expect(deriveSubagentBarStatus({ run: null, nodes: [] })).toBeNull();
  });
});

describe("formatSubagentBarStatus", () => {
  it("names the completed duration", () => {
    expect(
      formatSubagentBarStatus(
        { phase: "completed", startedAt: STARTED, completedAt: COMPLETED },
        0,
      ),
    ).toBe("Completed in 8m 1s");
  });

  it("ticks whole seconds while working", () => {
    expect(
      formatSubagentBarStatus(
        { phase: "working", startedAt: STARTED, completedAt: null },
        Date.parse(STARTED) + 12_900,
      ),
    ).toBe("Working 12s");
  });

  it("falls back to the bare status", () => {
    expect(formatSubagentBarStatus(null, 0)).toBe("Starting");
    expect(
      formatSubagentBarStatus({ phase: "failed", startedAt: STARTED, completedAt: COMPLETED }, 0),
    ).toBe("Failed");
  });
});

describe("describeSubagentModel", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const models: ReadonlyArray<ServerProviderModel> = [
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
            ],
          },
        ],
      },
    },
  ];

  it("names the model and effort as the composer pickers do", () => {
    expect(
      describeSubagentModel(
        createModelSelection(instanceId, "claude-opus-5-5", [{ id: "effort", value: "medium" }]),
        ProviderDriverKind.make("claudeAgent"),
        models,
      ),
    ).toEqual({ modelLabel: "Claude Opus 5.5", effortLabel: "Medium" });
  });

  it("shows the raw model without guessing an effort when the catalog lacks it", () => {
    expect(
      describeSubagentModel(createModelSelection(instanceId, "opus-preview"), null, models),
    ).toEqual({ modelLabel: "opus-preview", effortLabel: null });
  });
});
