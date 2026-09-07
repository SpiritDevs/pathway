import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Holds early child notifications until registration supplies their projection context. */
export function makeCodexPendingNotifications(input?: {
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}) {
  const maxEvents = Math.max(1, input?.maxEvents ?? 256);
  const maxBytes = Math.max(1, input?.maxBytes ?? 1_048_576);
  const pending: Array<{ key: string; bytes: number; run: Effect.Effect<void> }> = [];
  let bytes = 0;

  return {
    enqueue: Effect.fn("CodexPendingNotifications.enqueue")(function* (
      key: string,
      payload: unknown,
      run: Effect.Effect<void>,
    ) {
      const size = new TextEncoder().encode(encodePayload(payload)).byteLength;
      if (size > maxBytes) {
        yield* Effect.logWarning("orchestration-v2.codex-early-notification-too-large", { key });
        return;
      }
      let dropped = 0;
      while (pending.length >= maxEvents || bytes + size > maxBytes) {
        const oldest = pending.shift();
        if (oldest === undefined) break;
        bytes -= oldest.bytes;
        dropped += 1;
      }
      pending.push({ key, bytes: size, run });
      bytes += size;
      if (dropped > 0) {
        yield* Effect.logWarning("orchestration-v2.codex-early-notification-overflow", { dropped });
      }
    }),
    drain: Effect.fn("CodexPendingNotifications.drain")(function* (key: string) {
      const matching = pending.filter((entry) => entry.key === key);
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const entry = pending[index]!;
        if (entry.key === key) {
          bytes -= entry.bytes;
          pending.splice(index, 1);
        }
      }
      for (const entry of matching) yield* entry.run;
    }),
  };
}
