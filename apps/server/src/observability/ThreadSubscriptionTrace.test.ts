import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetThreadProjectionError,
  ThreadId,
} from "@spiritdevs/contracts";
import {
  makeLocalFileTracer,
  spanToTraceRecord,
  type TraceRecord,
} from "@spiritdevs/shared/observability";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import { threadSubscriptionTraceRecord } from "./ThreadSubscriptionTrace.ts";

const threadId = ThreadId.make("thread:missing");
const rpcSpanName = `ws.rpc.${ORCHESTRATION_V2_WS_METHODS.subscribeThread}`;

describe("thread subscription trace output", () => {
  it.effect("writes one concise record for expected absence across four layers", () =>
    Effect.gen(function* () {
      const records: TraceRecord[] = [];
      const delegated: string[] = [];
      const tracer = yield* makeLocalFileTracer({
        filePath: "unused",
        maxBytes: 1_000_000,
        maxFiles: 1,
        batchWindowMs: 10,
        sink: {
          filePath: "unused",
          push: (record) => {
            records.push(record);
          },
          flush: Effect.void,
          close: () => Effect.void,
        },
        delegate: Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (endTime, exit) => {
              end(endTime, exit);
              delegated.push(span.name);
            };
            return span;
          },
        }),
        spanToRecord: threadSubscriptionTraceRecord,
      });
      const error = new ProjectionStoreThreadNotFoundError({ threadId });
      const exit = yield* Effect.fail(error).pipe(
        Effect.withSpan("ProjectionStoreV2.readHistoryProjection"),
        Effect.withSpan("sql.transaction"),
        Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId,
              reason: "not_found",
              message: "Missing thread",
              cause,
            }),
        ),
        Effect.withSpan("ws.orchestrationV2.subscribeThread"),
        Effect.withSpan(rpcSpanName, { attributes: { "orchestration_v2.thread_id": threadId } }),
        Effect.withTracer(tracer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(records).toHaveLength(1);
      expect(records[0]!.name).toBe(rpcSpanName);
      expect(records[0]!.type === "effect-span" && records[0]!.exit).toEqual({
        _tag: "Failure",
        cause: `Thread not found: ${threadId}`,
      });
      expect(delegated).toHaveLength(4);
    }),
  );

  it.effect("preserves real, mixed, unrelated and defect failures", () =>
    Effect.gen(function* () {
      const parent = yield* Effect.makeSpan(rpcSpanName, {
        attributes: { "orchestration_v2.thread_id": threadId },
      });
      for (const cause of [
        Cause.fail(new Error("database failure")),
        Cause.fail(
          new ProjectionStoreThreadNotFoundError({ threadId: ThreadId.make("thread:fork-source") }),
        ),
        Cause.die(new ProjectionStoreThreadNotFoundError({ threadId })),
        Cause.combine(
          Cause.fail(new ProjectionStoreThreadNotFoundError({ threadId })),
          Cause.fail(new Error("database failure")),
        ),
      ]) {
        const span = yield* Effect.makeSpan("sql.transaction", { parent });
        span.end(span.status.startTime + 2_000_000n, Exit.failCause(cause));
        const serializable = { ...span, events: [] };
        expect(threadSubscriptionTraceRecord(serializable)).toEqual(
          spanToTraceRecord(serializable),
        );
      }
      const unrelated = yield* Effect.makeSpan("other.subscription", { root: true });
      unrelated.end(
        unrelated.status.startTime + 2_000_000n,
        Exit.fail(new ProjectionStoreThreadNotFoundError({ threadId })),
      );
      const serializable = { ...unrelated, events: [] };
      expect(threadSubscriptionTraceRecord(serializable)).toEqual(spanToTraceRecord(serializable));
    }),
  );
});
