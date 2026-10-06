import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  RunId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { createThreadCheckpointSummaryDeriver } from "./threadCheckpoints.ts";

const runId = RunId.make("checkpoint-run");
const checkpoint: OrchestrationV2Checkpoint = {
  id: CheckpointId.make("checkpoint-1"),
  threadId: v2ThreadId,
  scopeId: CheckpointScopeId.make("scope-1"),
  runId,
  nodeId: NodeId.make("node-1"),
  parentCheckpointId: null,
  ordinalWithinScope: 1,
  appRunOrdinal: 1,
  ref: CheckpointRef.make("refs/pathway/checkpoint-1"),
  status: "ready",
  files: [],
  capturedAt: v2Now,
};
function message(
  id: string,
  role: OrchestrationV2ConversationMessage["role"] = "assistant",
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId: v2ThreadId,
    runId,
    nodeId: null,
    role,
    text: "Hello",
    attachments: [],
    streaming: true,
    createdAt: v2Now,
    updatedAt: v2Now,
    createdBy: "agent",
    creationSource: "provider",
  };
}

describe("checkpoint summary cache", () => {
  it("keeps rows and arrays stable when only message content or other projection fields change", () => {
    const derive = createThreadCheckpointSummaryDeriver();
    const projection = {
      ...v2Projection,
      checkpoints: [checkpoint],
      messages: [message("a"), message("b")],
    };
    const first = derive(projection);
    expect(first[0]?.assistantMessageId).toBe("b");
    expect(
      derive({
        ...projection,
        messages: projection.messages.map((entry) => ({ ...entry, text: "Streamed text" })),
      }),
    ).toBe(first);
    expect(derive({ ...projection, checkpoints: [...projection.checkpoints] })).toBe(first);
  });

  it("refreshes associations for new messages, changed roles, and changed runs", () => {
    const derive = createThreadCheckpointSummaryDeriver();
    const projection = { ...v2Projection, checkpoints: [checkpoint], messages: [message("a")] };
    const first = derive(projection);
    const second = derive({ ...projection, messages: [message("a"), message("b")] });
    expect(second).not.toBe(first);
    expect(second[0]?.assistantMessageId).toBe("b");
    expect(
      derive({ ...projection, messages: [message("a", "user")] })[0]?.assistantMessageId,
    ).toBeNull();
    expect(
      derive({ ...projection, messages: [{ ...message("a"), runId: RunId.make("other") }] })[0]
        ?.assistantMessageId,
    ).toBeNull();
  });

  it("reuses unchanged checkpoint rows while updating files and status", () => {
    const derive = createThreadCheckpointSummaryDeriver();
    const second = { ...checkpoint, id: CheckpointId.make("checkpoint-2"), appRunOrdinal: 2 };
    const projection = {
      ...v2Projection,
      checkpoints: [checkpoint, second],
      messages: [message("a")],
    };
    const first = derive(projection);
    const next = derive({
      ...projection,
      checkpoints: [
        checkpoint,
        {
          ...second,
          status: "stale" as const,
          files: [{ path: "app.ts", kind: "modified", additions: 1, deletions: 0 }],
        },
      ],
    });
    expect(next[0]).toBe(first[0]);
    expect(next[1]?.status).toBe("stale");
    expect(next[1]?.files).toHaveLength(1);
    expect(derive({ ...projection, checkpoints: [] })).toEqual([]);
  });

  it("tracks the last assistant after reordering, removal and an empty snapshot", () => {
    const derive = createThreadCheckpointSummaryDeriver();
    const projection = {
      ...v2Projection,
      checkpoints: [checkpoint],
      messages: [message("a"), message("b")],
    };
    expect(derive(projection)[0]?.assistantMessageId).toBe("b");
    expect(
      derive({ ...projection, messages: [message("b"), message("a")] })[0]?.assistantMessageId,
    ).toBe("a");
    expect(derive({ ...projection, messages: [message("b")] })[0]?.assistantMessageId).toBe("b");
    expect(derive({ ...projection, messages: [] })[0]?.assistantMessageId).toBeNull();
    expect(derive(v2Projection)).toEqual([]);
    expect(derive(projection)[0]?.assistantMessageId).toBe("b");
  });

  it("omits checkpoints without a run or turn ordinal", () => {
    const derive = createThreadCheckpointSummaryDeriver();
    expect(
      derive({
        ...v2Projection,
        checkpoints: [
          { ...checkpoint, runId: null },
          { ...checkpoint, appRunOrdinal: null },
        ],
      }),
    ).toEqual([]);
  });
});
