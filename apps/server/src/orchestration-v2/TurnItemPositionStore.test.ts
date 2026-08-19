import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  layer as turnItemPositionStoreLayer,
  TurnItemPositionStoreV2,
} from "./TurnItemPositionStore.ts";

// The layer is shared across the tests in this file, so each case owns a thread.
const runId = RunId.make("run:positions:1");

const layer = it.layer(Layer.provide(turnItemPositionStoreLayer, SqlitePersistenceMemory));

layer("TurnItemPositionStoreV2", (it) => {
  it.effect("bands a run's items under that run's ordinal", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:positions:banded");
      const positions = yield* TurnItemPositionStoreV2;
      const first = yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("item:run:1"),
        runId,
        runOrdinal: 1,
      });
      const second = yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("item:run:2"),
        runId,
        runOrdinal: 1,
      });
      assert.equal(first, 1_000_001);
      assert.equal(second, 1_000_002);
    }),
  );

  it.effect("appends a run-less item after everything the thread holds", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:positions:marker");
      const positions = yield* TurnItemPositionStoreV2;
      yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("item:run:1"),
        runId,
        runOrdinal: 1,
      });
      const marker = yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("item:source-control"),
        runId: null,
      });
      assert.equal(marker, 1_000_002);
    }),
  );

  it.effect("starts run-less items at the front of an empty thread", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:positions:runless");
      const positions = yield* TurnItemPositionStoreV2;
      const first = yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("item:subagent:1"),
        runId: null,
      });
      const second = yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("item:subagent:2"),
        runId: null,
      });
      assert.equal(first, 1);
      assert.equal(second, 2);
    }),
  );
});
