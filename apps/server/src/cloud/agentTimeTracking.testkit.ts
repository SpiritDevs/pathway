import { OrchestrationV2DomainEventJson } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
const decode = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
export const timestamp = (seconds: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"), { seconds }));
export const runEvent = (status: string, seconds: number, type = "run.updated", id = "run-1") =>
  decode({
    id: `event-${seconds}-${status}`,
    threadId: "thread-1",
    runId: id,
    type,
    occurredAt: timestamp(seconds),
    payload: {
      id,
      threadId: "thread-1",
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      providerThreadId: null,
      userMessageId: "message-1",
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: timestamp(0),
      startedAt: status === "queued" ? null : timestamp(0),
      completedAt: ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
        status,
      )
        ? timestamp(seconds)
        : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
