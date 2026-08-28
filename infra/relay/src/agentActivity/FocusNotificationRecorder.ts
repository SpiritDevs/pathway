import type { AttentionEvent } from "@spiritdevs/contracts";
import { api } from "@spiritdevs/backend/convexApi";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RelayConvexClient } from "../db.ts";

export class FocusNotificationRecordPersistenceError extends Schema.TaggedErrorClass<FocusNotificationRecordPersistenceError>()(
  "FocusNotificationRecordPersistenceError",
  {
    environmentId: Schema.String,
    eventId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to record Focus notification ${this.eventId} for environment ${this.environmentId}.`;
  }
}

export class FocusNotificationRecorder extends Context.Service<
  FocusNotificationRecorder,
  {
    readonly record: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly event: AttentionEvent;
    }) => Effect.Effect<number, FocusNotificationRecordPersistenceError>;
  }
>()("pathway-relay/agentActivity/FocusNotificationRecorder") {}

export const make = Effect.gen(function* () {
  const client = yield* RelayConvexClient;

  return FocusNotificationRecorder.of({
    record: Effect.fn("relay.focus_notification_recorder.record")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.thread_id": input.event.threadId,
        "relay.attention_event_id": input.event.eventId,
        "relay.attention_event_kind": input.event.eventKind,
      });
      return yield* client
        .mutation(api.focusNotifications.record, {
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          eventId: input.event.eventId,
          threadId: input.event.threadId,
          projectKey: input.event.projectKey,
          eventKind: input.event.eventKind,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new FocusNotificationRecordPersistenceError({
                environmentId: input.environmentId,
                eventId: input.event.eventId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(FocusNotificationRecorder, make);
