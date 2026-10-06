import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetThreadProjectionError,
  ThreadId,
} from "@spiritdevs/contracts";
import { spanToTraceRecord, type SerializableSpan } from "@spiritdevs/shared/observability";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const rpcSpanName = `ws.rpc.${ORCHESTRATION_V2_WS_METHODS.subscribeThread}`;
const isProjectionError = Schema.is(OrchestrationV2GetThreadProjectionError);
const isStoreNotFound = Schema.is(
  Schema.TaggedStruct("ProjectionStoreThreadNotFoundError", {
    threadId: ThreadId,
  }),
);
const isOrchestratorProjectionError = Schema.is(
  Schema.TaggedStruct("OrchestratorProjectionError", {
    threadId: ThreadId,
    cause: Schema.Unknown,
  }),
);
const isThreadId = Schema.is(ThreadId);

function isExpectedAbsence(error: unknown, threadId: ThreadId): boolean {
  if (isProjectionError(error)) return error.threadId === threadId && error.reason === "not_found";
  if (isStoreNotFound(error)) return error.threadId === threadId;
  return (
    isOrchestratorProjectionError(error) &&
    error.threadId === threadId &&
    isStoreNotFound(error.cause) &&
    error.cause.threadId === threadId
  );
}

// Only local trace output is condensed. Delegates and RPC metrics still see
// every span, and missing fork sources or mixed/defect failures keep full traces.
export function threadSubscriptionTraceRecord(span: SerializableSpan) {
  const status = span.status;
  if (status._tag !== "Ended" || Exit.isSuccess(status.exit) || span.events.length > 0)
    return spanToTraceRecord(span);
  let rpcSpan: Pick<SerializableSpan, "name" | "parent" | "attributes"> = span;
  while (rpcSpan.name !== rpcSpanName) {
    const parent = Option.getOrUndefined(rpcSpan.parent);
    if (parent?._tag !== "Span") return spanToTraceRecord(span);
    rpcSpan = parent;
  }
  const threadId = rpcSpan.attributes.get("orchestration_v2.thread_id");
  if (
    !isThreadId(threadId) ||
    status.exit.cause.reasons.length === 0 ||
    !status.exit.cause.reasons.every(
      (reason) => reason._tag === "Fail" && isExpectedAbsence(reason.error, threadId),
    )
  )
    return spanToTraceRecord(span);
  if (span !== rpcSpan) return undefined;
  return {
    ...spanToTraceRecord({ ...span, status: { ...status, exit: Exit.void } }),
    exit: { _tag: "Failure" as const, cause: `Thread not found: ${threadId}` },
  };
}
