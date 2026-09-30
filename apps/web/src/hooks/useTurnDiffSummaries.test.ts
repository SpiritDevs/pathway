import { CheckpointRef, MessageId, RunId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TurnDiffSummary } from "../types";
import { sameTurnDiffSummaries } from "./useTurnDiffSummaries";

function summary(overrides: Partial<TurnDiffSummary> = {}): TurnDiffSummary {
  return {
    runId: RunId.make("run-1"),
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make("refs/pathway/checkpoint-1"),
    status: "ready",
    files: [{ path: "src/app.ts", kind: "modified", additions: 3, deletions: 1 }],
    assistantMessageId: MessageId.make("message-1"),
    completedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("sameTurnDiffSummaries", () => {
  it("treats a fresh derivation of unchanged checkpoints as the same", () => {
    expect(sameTurnDiffSummaries([summary()], [summary()])).toBe(true);
  });

  it("notices a checkpoint landing or a file count changing", () => {
    expect(
      sameTurnDiffSummaries([summary()], [summary(), summary({ checkpointTurnCount: 2 })]),
    ).toBe(false);
    expect(
      sameTurnDiffSummaries(
        [summary()],
        [
          summary({
            files: [{ path: "src/app.ts", kind: "modified", additions: 4, deletions: 1 }],
          }),
        ],
      ),
    ).toBe(false);
    expect(sameTurnDiffSummaries([summary()], [summary({ status: "missing" })])).toBe(false);
  });
});
