import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import {
  previewToolOutput,
  threadEventPayload,
  toolOutput,
  TOOL_OUTPUT_INLINE_BYTES,
} from "./ThreadPayload.ts";

const now = DateTime.makeUnsafe("2026-10-07T00:00:00Z");
const command = (
  output: string,
): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> => ({
  id: TurnItemId.make("tool:1"),
  threadId: ThreadId.make("thread:1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  type: "command_execution",
  status: "completed",
  title: null,
  input: "example",
  output,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

it("leaves small outputs unchanged and bounds oversized output by bytes with both edges", () => {
  const small = command("x".repeat(TOOL_OUTPUT_INLINE_BYTES));
  assert.strictEqual(previewToolOutput(small), small);
  const original = command(`first\n${"💬".repeat(100_000)}\nlast`);
  const preview = previewToolOutput(original);
  assert.equal(preview.type, "command_execution");
  if (preview.type !== "command_execution") return;
  assert.equal(preview.outputPreview?.totalBytes, Buffer.byteLength(original.output!));
  assert.equal(preview.outputPreview?.format, "text");
  assert.isBelow(Buffer.byteLength(preview.output!), 8_300);
  assert.isTrue(preview.output!.startsWith("first\n"));
  assert.isTrue(preview.output!.endsWith("\nlast"));
  assert.isFalse(preview.output!.includes("�"));
  assert.equal(original.output, `first\n${"💬".repeat(100_000)}\nlast`);
});

it("previews structured dynamic output without changing its complete stored value", () => {
  const { input: _, output: __, ...base } = command("");
  const output = { content: ["x".repeat(100_000)], end: "last" };
  const item: OrchestrationV2TurnItem = {
    ...base,
    type: "dynamic_tool",
    toolName: "example",
    input: {},
    output,
  };
  const preview = previewToolOutput(item);
  if (preview.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
  assert.equal(preview.outputPreview?.format, "json");
  assert.equal(preview.outputPreview?.totalBytes, Buffer.byteLength(JSON.stringify(output)));
  assert.isString(preview.output);
  assert.strictEqual(item.output, output);
  assert.deepEqual(toolOutput(item), {
    text: JSON.stringify(output),
    totalBytes: Buffer.byteLength(JSON.stringify(output)),
    format: "json",
  });
});

it("bounds live and replay item events only for compact-v1 subscribers", () => {
  const event = {
    id: EventId.make("event:1"),
    threadId: ThreadId.make("thread:1"),
    occurredAt: now,
    type: "turn-item.updated" as const,
    payload: command("x".repeat(100_000)),
  };
  assert.strictEqual(threadEventPayload(event), event);
  assert.strictEqual(threadEventPayload(event, "references-v1"), event);
  const compact = threadEventPayload(event, "compact-v1");
  assert.equal(compact.type, "turn-item.updated");
  if (compact.type !== "turn-item.updated") return;
  assert.isBelow(JSON.stringify(compact.payload).length, 9_000);
  assert.equal(event.payload.output!.length, 100_000);
});
