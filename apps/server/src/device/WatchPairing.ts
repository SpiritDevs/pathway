import { DeviceOperationError } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DeviceHostReady } from "./DeviceHost.ts";

const Pair = Schema.Struct({
  watch: Schema.Struct({ udid: Schema.String }),
  phone: Schema.Struct({ udid: Schema.String }),
  state: Schema.String,
});
const decodePairs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      pairs: Schema.Record(Schema.String, Pair),
    }),
  ),
);

export const runSimctl = Effect.fn("runSimctl")(function* (
  ready: DeviceHostReady,
  operation: string,
  args: ReadonlyArray<string>,
) {
  const result = yield* ready.run("xcrun", ["simctl", ...args]);
  if (result.code !== 0)
    return yield* new DeviceOperationError({
      operation,
      reason: "command_failed",
      exitCode: result.code,
      cause: result,
    });
  return result.stdout;
});

export const readWatchPairs = Effect.fn("readWatchPairs")(function* (ready: DeviceHostReady) {
  const text = yield* runSimctl(ready, "read watch pairs", ["list", "pairs", "--json"]);
  const { pairs } = yield* decodePairs(text).pipe(
    Effect.mapError(
      (cause) =>
        new DeviceOperationError({
          operation: "read watch pairs",
          reason: "request_failed",
          cause,
        }),
    ),
  );
  return pairs;
});

export const readWatchPair = Effect.fn("readWatchPair")(function* (
  ready: DeviceHostReady,
  deviceId: string,
) {
  const pairs = yield* readWatchPairs(ready);
  const pair = Object.entries(pairs).find(([, pair]) => pair.watch.udid === deviceId);
  return pair ? { pairId: pair[0], phoneDeviceId: pair[1].phone.udid, state: pair[1].state } : null;
});
