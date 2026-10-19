import type {
  MessageId,
  OrchestrationV2ThreadHistory,
  OrchestrationV2ThreadHistoryRequest,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A large reconnect replaces replay with a recent snapshot; global sequence gaps are not a count. */
export const threadHistoryNeedsSnapshot = Effect.fn("threadHistoryNeedsSnapshot")(function* (
  threadId: ThreadId,
  afterSequence: number,
  throughSequence: number,
) {
  if (afterSequence > throughSequence) return true;
  const sql = yield* SqlClient.SqlClient;
  const backlog = yield* sql<{ sequence: number }>`
    SELECT sequence FROM orchestration_events
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
      AND stream_id = ${threadId}
      AND sequence > ${afterSequence} AND sequence <= ${throughSequence}
    ORDER BY sequence LIMIT 251
  `;
  return backlog.length > 250;
});

/** Small projection columns used to choose a page before reading message/tool bodies. */
export interface ThreadHistoryItem {
  readonly id: TurnItemId;
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly nodeId: OrchestrationV2TurnItem["nodeId"];
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly ordinal: number;
  readonly inputIntent?: Extract<OrchestrationV2TurnItem, { type: "user_message" }>["inputIntent"];
  readonly messageId?: MessageId;
  readonly preview?: string;
}

export function selectThreadHistory(
  items: ReadonlyArray<ThreadHistoryItem>,
  request: OrchestrationV2ThreadHistoryRequest,
): {
  readonly start: number;
  readonly items: ReadonlyArray<ThreadHistoryItem>;
  readonly history: OrchestrationV2ThreadHistory;
} {
  let start = Math.max(0, items.length - request.limit);
  let end = items.length;
  if (request.before !== undefined) {
    const position = items.findIndex((item) => item.id === request.before);
    if (position === -1) throw new RangeError("The older-history cursor is no longer available.");
    if (position !== -1) {
      end = position;
      start = Math.max(0, end - request.limit);
    }
  } else if (request.after !== undefined) {
    const position = items.findIndex((item) => item.id === request.after);
    if (position === -1) throw new RangeError("The newer-history cursor is no longer available.");
    if (position !== -1) {
      start = position + 1;
      end = Math.min(items.length, start + request.limit);
    }
  } else if (request.around !== undefined) {
    const position = items.findIndex((item) => item.messageId === request.around);
    if (position === -1)
      throw new RangeError("The requested history message is no longer available.");
    if (position !== -1) {
      start = Math.max(
        0,
        Math.min(position - Math.floor(request.limit / 2), items.length - request.limit),
      );
      end = Math.min(items.length, start + request.limit);
    }
  }
  const page = items.slice(start, end);
  const index: Array<OrchestrationV2ThreadHistory["index"][number]> = [];
  for (const item of items) {
    if (item.type === "user_message" && item.messageId !== undefined) {
      index.push({ messageId: item.messageId, role: "user", preview: item.preview ?? "" });
    } else if (item.type === "assistant_message" && index.length > 0) {
      const previous = index[index.length - 1]!;
      index[index.length - 1] = { ...previous, assistantPreview: item.preview ?? "" };
    }
  }
  const first = page[0];
  const last = page.at(-1);
  return {
    start,
    items: page,
    history: {
      hasOlder: start > 0,
      hasNewer: end < items.length,
      ...(first === undefined ? {} : { beforeCursor: first.id }),
      ...(last === undefined ? {} : { afterCursor: last.id }),
      index,
    },
  };
}
