import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import {
  itemDetail,
  previewItemDetails,
  threadEventPayload,
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
  assert.strictEqual(previewItemDetails(small), small);
  const original = command(`first\n${"💬".repeat(100_000)}\nlast`);
  const preview = previewItemDetails(original);
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
  const preview = previewItemDetails(item);
  if (preview.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
  assert.equal(preview.outputPreview?.format, "json");
  assert.equal(preview.outputPreview?.totalBytes, Buffer.byteLength(JSON.stringify(output)));
  assert.isString(preview.output);
  assert.strictEqual(item.output, output);
  assert.deepEqual(itemDetail(item, "output"), {
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

const huge = `first\n${"💬".repeat(500_000)}\nlast`;
const base = (() => {
  const { input: _, output: __, type: ___, ...rest } = command("");
  return rest;
})();

it("bounds file-change bodies, dynamic input and subagent text and keeps them retrievable", () => {
  const fileChange: OrchestrationV2TurnItem = {
    ...base,
    type: "file_change",
    fileName: "src/large.ts",
    diffStr: huge,
    oldStr: "small",
    newStr: huge,
  };
  const input = { path: "src/large.ts", content: huge };
  const dynamic: OrchestrationV2TurnItem = {
    ...base,
    type: "dynamic_tool",
    toolName: "write",
    input,
    output: "ok",
  };
  const subagent: OrchestrationV2TurnItem = {
    ...base,
    type: "subagent",
    subagentId: NodeId.make("node:1"),
    origin: "app_owned",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    childThreadId: null,
    prompt: "Review the change",
    progress: huge,
    result: huge,
  };
  for (const item of [fileChange, dynamic, subagent]) {
    const preview = previewItemDetails(item);
    assert.isBelow(Buffer.byteLength(JSON.stringify(preview)), 30_000);
    assert.isFalse(JSON.stringify(preview).includes("�"));
  }

  const diff = previewItemDetails(fileChange);
  if (diff.type !== "file_change") return assert.fail("Expected file change");
  assert.deepEqual(diff.diffStrPreview, { totalBytes: Buffer.byteLength(huge), format: "text" });
  assert.isDefined(diff.newStrPreview);
  assert.equal(diff.oldStr, "small");
  assert.isUndefined(diff.oldStrPreview);
  assert.isTrue(diff.diffStr!.startsWith("first\n") && diff.diffStr!.endsWith("\nlast"));
  assert.equal(itemDetail(fileChange, "diffStr")?.text, huge);

  const tool = previewItemDetails(dynamic);
  if (tool.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
  assert.equal(tool.inputPreview?.format, "json");
  assert.isString(tool.input);
  assert.equal(tool.output, "ok");
  assert.isUndefined(tool.outputPreview);
  assert.strictEqual(dynamic.input, input);
  assert.equal(itemDetail(dynamic, "input")?.text, JSON.stringify(input));

  const agent = previewItemDetails(subagent);
  if (agent.type !== "subagent") return assert.fail("Expected subagent");
  assert.equal(agent.prompt, "Review the change");
  assert.isUndefined(agent.promptPreview);
  assert.equal(agent.resultPreview?.totalBytes, Buffer.byteLength(huge));
  assert.equal(agent.progressPreview?.totalBytes, Buffer.byteLength(huge));
  assert.equal(itemDetail(subagent, "result")?.text, huge);
  assert.isNull(itemDetail(subagent, "diffStr"));
});
