import {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItemJson,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadPayloadFormat,
  OrchestrationV2ThreadProjectionJson,
  OrchestrationV2TurnItemJson,
  ThreadId,
  compactThreadProjection,
  type OrchestrationV2ThreadProjection,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { resolveThreadProjectionPayload } from "../state/threadPayload.ts";

// Bumped whenever an older client could misread a newer entry: v4 marks partial history, v5 stores
// visible thread rows as item references.
export const ORCHESTRATION_CACHE_SCHEMA_VERSION = 5 as const;

/**
 * Persists the same item references as the compact wire format, so each item body is stored once.
 * Decoding resolves the references, which makes every visible row share its canonical item object.
 * A broken reference fails the decode, and the cache entry is discarded.
 */
const StoredThreadProjection = OrchestrationV2ThreadProjectionJson.mapFields((fields) => ({
  ...fields,
  payloadFormat: OrchestrationV2ThreadPayloadFormat,
  referencedTurnItems: Schema.Array(OrchestrationV2TurnItemJson),
  visibleTurnItems: Schema.Array(
    OrchestrationV2ProjectedTurnItemJson.mapFields(({ item: _, ...reference }) => reference),
  ),
})).pipe(
  Schema.decodeTo(
    // Passes the resolved projection through untouched; re-parsing it would copy shared items.
    Schema.declare(
      (input): input is OrchestrationV2ThreadProjection =>
        typeof input === "object" && input !== null,
    ),
    SchemaTransformation.transformOrFail({
      decode: (stored) =>
        Effect.try({
          try: () => resolveThreadProjectionPayload(stored),
          catch: (cause) => new SchemaIssue.InvalidValue({ message: String(cause) }),
        }),
      encode: (projection) => Effect.succeed(compactThreadProjection(projection, "references-v1")),
    }),
  ),
);

export const StoredOrchestrationShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshotJson,
});

export const StoredOrchestrationThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationV2ThreadDetailSnapshot.mapFields((fields) => ({
    ...fields,
    projection: StoredThreadProjection,
  })),
});

/**
 * Invalid orchestration caches are disposable and must never block live synchronization. The
 * failure is logged because a codec bug otherwise looks like a cold cache on every launch.
 */
export function decodeOrDiscardOrchestrationCache<A, E, R, E2, R2>(
  decode: Effect.Effect<Option.Option<A>, E, R>,
  discard: Effect.Effect<void, E2, R2>,
) {
  return decode.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Discarding unreadable orchestration cache.", { error }).pipe(
        Effect.andThen(discard),
        Effect.as(Option.none<A>()),
      ),
    ),
  );
}
