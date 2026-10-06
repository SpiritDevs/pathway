import {
  OrchestrationV2TurnItemJson,
  type OrchestrationV2CompactThreadProjection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadPayloadFormat,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type TurnItemId,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const TOOL_OUTPUT_INLINE_BYTES = 16_384;
export const TOOL_OUTPUT_PREVIEW_EDGE_BYTES = 4_096;
const decodeTurnItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);

export function toolOutput(item: OrchestrationV2TurnItem) {
  if (item.type !== "command_execution" && item.type !== "dynamic_tool") return null;
  if (item.output === undefined) return null;
  const text = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
  if (text === undefined) return null;
  return {
    text,
    totalBytes: Buffer.byteLength(text),
    format: typeof item.output === "string" ? ("text" as const) : ("json" as const),
  };
}

export function previewToolOutput(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "command_execution" && item.type !== "dynamic_tool") return item;
  const output = toolOutput(item);
  if (output === null || output.totalBytes <= TOOL_OUTPUT_INLINE_BYTES) return item;
  const bytes = Buffer.from(output.text);
  let headEnd = TOOL_OUTPUT_PREVIEW_EDGE_BYTES;
  let tailStart = bytes.length - TOOL_OUTPUT_PREVIEW_EDGE_BYTES;
  // Keep UTF-8 code points whole at the two preview boundaries.
  while ((bytes[headEnd]! & 0xc0) === 0x80) headEnd--;
  while ((bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
  const preview = `${bytes.toString("utf8", 0, headEnd)}\n… output omitted …\n${bytes.toString("utf8", tailStart)}`;
  return {
    ...item,
    output: preview,
    outputPreview: { totalBytes: output.totalBytes, format: output.format },
  };
}

/** Only opted-in transports use this view; persisted events and internal projections stay complete. */
export function threadProjectionPayload(
  projection: OrchestrationV2ThreadProjection,
  payloadFormat?: OrchestrationV2ThreadPayloadFormat,
): OrchestrationV2ThreadProjection | OrchestrationV2CompactThreadProjection {
  if (payloadFormat === undefined) return projection;
  const projectItem =
    payloadFormat === "compact-v1" ? previewToolOutput : (item: OrchestrationV2TurnItem) => item;
  const canonicalIds = new Set(projection.turnItems.map((item) => item.id));
  const referencedItems = new Map<TurnItemId, OrchestrationV2TurnItem>();
  const visibleTurnItems = projection.visibleTurnItems.map(({ item, ...reference }) => {
    if (!canonicalIds.has(item.id)) referencedItems.set(item.id, item);
    return reference;
  });
  return {
    ...projection,
    payloadFormat,
    turnItems: projection.turnItems.map(projectItem),
    referencedTurnItems: [...referencedItems.values()].map(projectItem),
    visibleTurnItems,
  };
}

export function threadEventPayload(
  event: OrchestrationV2DomainEvent,
  payloadFormat?: OrchestrationV2ThreadPayloadFormat,
): OrchestrationV2DomainEvent {
  return payloadFormat === "compact-v1" && event.type === "turn-item.updated"
    ? { ...event, payload: previewToolOutput(event.payload) }
    : event;
}

/** Fetch a single canonical output, scoped to its owning thread, without loading thread history. */
export const readToolOutput = Effect.fn("ThreadPayload.readToolOutput")(function* (
  threadId: ThreadId,
  itemId: TurnItemId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId} AND turn_item_id = ${itemId}
  `;
  if (rows[0] === undefined) return null;
  const item = yield* decodeTurnItem(rows[0].payload_json);
  return toolOutput(item);
});
