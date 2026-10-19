import {
  OrchestrationV2TurnItemJson,
  type OrchestrationV2CompactThreadProjection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ItemDetailField,
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

/** The fields of each item kind that can grow without bound. */
const DETAIL_FIELDS: Partial<
  Record<OrchestrationV2TurnItem["type"], ReadonlyArray<OrchestrationV2ItemDetailField>>
> = {
  command_execution: ["output"],
  dynamic_tool: ["input", "output"],
  file_change: ["diffStr", "oldStr", "newStr"],
  subagent: ["prompt", "progress", "result"],
};

/** The complete text of one detail field, or null when the item has no such value. */
export function itemDetail(item: OrchestrationV2TurnItem, field: OrchestrationV2ItemDetailField) {
  if (!DETAIL_FIELDS[item.type]?.includes(field)) return null;
  const value: unknown = Reflect.get(item, field);
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return null;
  return {
    text,
    totalBytes: Buffer.byteLength(text),
    format: typeof value === "string" ? ("text" as const) : ("json" as const),
  };
}

/** The first and last edge bytes of a long text, encoding only those slices. */
function edgePreview(text: string) {
  const head = Buffer.from(text.slice(0, TOOL_OUTPUT_PREVIEW_EDGE_BYTES));
  const tail = Buffer.from(text.slice(-TOOL_OUTPUT_PREVIEW_EDGE_BYTES));
  let headEnd = Math.min(head.length, TOOL_OUTPUT_PREVIEW_EDGE_BYTES);
  let tailStart = Math.max(0, tail.length - TOOL_OUTPUT_PREVIEW_EDGE_BYTES);
  // Keep UTF-8 code points whole at the two preview boundaries.
  while ((head[headEnd]! & 0xc0) === 0x80) headEnd--;
  while ((tail[tailStart]! & 0xc0) === 0x80) tailStart++;
  return `${head.toString("utf8", 0, headEnd)}\n… omitted …\n${tail.toString("utf8", tailStart)}`;
}

/**
 * Replaces each oversized detail field with an edge preview and records the complete
 * size in `<field>Preview`. Small items are returned unchanged.
 */
export function previewItemDetails(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  let previewed: Record<string, unknown> | null = null;
  for (const field of DETAIL_FIELDS[item.type] ?? []) {
    const detail = itemDetail(item, field);
    if (detail === null || detail.totalBytes <= TOOL_OUTPUT_INLINE_BYTES) continue;
    previewed ??= { ...item };
    previewed[field] = edgePreview(detail.text);
    previewed[`${field}Preview`] = { totalBytes: detail.totalBytes, format: detail.format };
  }
  // Every previewed field is a string or JSON value in its schema, so the item stays valid.
  return previewed === null ? item : (previewed as OrchestrationV2TurnItem);
}

/** Only opted-in transports use this view; persisted events and internal projections stay complete. */
export function threadProjectionPayload(
  projection: OrchestrationV2ThreadProjection,
  payloadFormat?: OrchestrationV2ThreadPayloadFormat,
): OrchestrationV2ThreadProjection | OrchestrationV2CompactThreadProjection {
  if (payloadFormat === undefined) return projection;
  const projectItem =
    payloadFormat === "compact-v1" ? previewItemDetails : (item: OrchestrationV2TurnItem) => item;
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
    ? { ...event, payload: previewItemDetails(event.payload) }
    : event;
}

/** Fetch one canonical item field, scoped to its owning thread, without loading thread history. */
export const readItemDetail = Effect.fn("ThreadPayload.readItemDetail")(function* (
  threadId: ThreadId,
  itemId: TurnItemId,
  field: OrchestrationV2ItemDetailField = "output",
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId} AND turn_item_id = ${itemId}
  `;
  if (rows[0] === undefined) return null;
  const item = yield* decodeTurnItem(rows[0].payload_json);
  return itemDetail(item, field);
});
