import { assert, it } from "@effect/vitest";
import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { handleTerminalEventWithPoisonIsolation } from "./Orchestrator.ts";

it.effect("isolates a poison terminal event and advances to later events", () =>
  Effect.gen(function* () {
    const cursor = yield* Ref.make(10);
    const handled: Array<number> = [];
    const stored = (sequence: number) =>
      ({
        sequence,
        commandId: null,
        event: {
          id: `event:terminal:${sequence}`,
          type: "run.updated",
          threadId: "thread:terminal-subscriber",
        },
      }) as unknown as OrchestrationV2StoredEvent;

    yield* handleTerminalEventWithPoisonIsolation({
      stored: stored(11),
      cursor,
      handle: () => Effect.fail("deterministic poison event"),
    });
    assert.equal(yield* Ref.get(cursor), 11);

    yield* handleTerminalEventWithPoisonIsolation({
      stored: stored(12),
      cursor,
      handle: (event) => Effect.sync(() => handled.push(event.sequence)),
    });
    assert.deepEqual(handled, [12]);
    assert.equal(yield* Ref.get(cursor), 12);
  }),
);
