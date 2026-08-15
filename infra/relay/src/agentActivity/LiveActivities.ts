import type {
  RelayAgentActivityAggregateState,
  RelayDeliveryKind,
  RelayLiveActivityRegistrationRequest,
} from "@spiritdevs/contracts/relay";
import { RelayDeliveryKind as RelayDeliveryKindSchema } from "@spiritdevs/contracts/relay";
import { api } from "@spiritdevs/backend/convexApi";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RelayConvexClient } from "../db.ts";

export class LiveActivityRegistrationPersistenceError extends Schema.TaggedErrorClass<LiveActivityRegistrationPersistenceError>()(
  "LiveActivityRegistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist Live Activity registration for user ${this.userId} and device ${this.deviceId}.`;
  }
}

export class LiveActivityTargetListPersistenceError extends Schema.TaggedErrorClass<LiveActivityTargetListPersistenceError>()(
  "LiveActivityTargetListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list Live Activity delivery targets for user ${this.userId}.`;
  }
}

export class LiveActivityDeliveryMarkPersistenceError extends Schema.TaggedErrorClass<LiveActivityDeliveryMarkPersistenceError>()(
  "LiveActivityDeliveryMarkPersistenceError",
  {
    operation: Schema.Literals([
      "mark-delivery",
      "mark-start-queued",
      "clear-start-queued",
      "invalidate-delivery-token",
    ]),
    userId: Schema.String,
    deviceId: Schema.String,
    kind: Schema.NullOr(RelayDeliveryKindSchema),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist Live Activity state during ${this.operation} for user ${this.userId} and device ${this.deviceId}.`;
  }
}

export interface DeviceRow {
  readonly user_id: string;
  readonly device_id: string;
  readonly platform: "ios";
  readonly ios_major_version: number;
  readonly app_version: string | null;
  readonly bundle_id: string | null;
  readonly aps_environment: "sandbox" | "production" | null;
  readonly push_token: string | null;
  readonly push_to_start_token: string | null;
  readonly preferences_json: string;
}

export interface LiveActivityRow {
  readonly activity_push_token: string | null;
  readonly remote_start_queued_at: string | null;
  readonly remote_started_at: string | null;
  readonly ended_at: string | null;
  readonly last_aggregate_json: string | null;
  readonly last_live_activity_delivery_at: string | null;
}

export type TargetRow = DeviceRow & LiveActivityRow;

export class LiveActivities extends Context.Service<
  LiveActivities,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly registration: RelayLiveActivityRegistrationRequest;
    }) => Effect.Effect<void, LiveActivityRegistrationPersistenceError>;
    readonly listTargets: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<TargetRow>, LiveActivityTargetListPersistenceError>;
    readonly markDelivery: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly kind: RelayDeliveryKind;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly deliveredAt: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
    readonly markStartQueued: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly queuedAt: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
    readonly clearStartQueued: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
    readonly invalidateDeliveryToken: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly kind: RelayDeliveryKind;
      readonly invalidatedAt: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
  }
>()("pathway-relay/agentActivity/LiveActivities") {}

export const make = Effect.gen(function* () {
  const client = yield* RelayConvexClient;

  return LiveActivities.of({
    register: Effect.fn("relay.live_activities.register")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.registration.deviceId,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* client
        .mutation(api.relayPersistence.registerLiveActivity, {
          userId: input.userId,
          deviceId: input.registration.deviceId,
          activityPushToken: input.registration.activityPushToken,
          now,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new LiveActivityRegistrationPersistenceError({
                userId: input.userId,
                deviceId: input.registration.deviceId,
                cause,
              }),
          ),
        );
    }),

    listTargets: Effect.fn("relay.live_activities.list_targets")(function* (input) {
      return yield* client.query(api.relayPersistence.listLiveActivityTargets, input).pipe(
        Effect.map(
          (rows): ReadonlyArray<TargetRow> =>
            rows.map((row) => ({
              user_id: row.userId,
              device_id: row.deviceId,
              platform: row.platform,
              ios_major_version: row.iosMajorVersion,
              app_version: row.appVersion,
              bundle_id: row.bundleId,
              aps_environment: row.apsEnvironment,
              push_token: row.pushToken,
              push_to_start_token: row.pushToStartToken,
              preferences_json: JSON.stringify(row.preferences),
              activity_push_token: row.activityPushToken,
              remote_start_queued_at: row.remoteStartQueuedAt,
              remote_started_at: row.remoteStartedAt,
              ended_at: row.endedAt,
              last_aggregate_json:
                row.lastAggregate === null ? null : JSON.stringify(row.lastAggregate),
              last_live_activity_delivery_at: row.lastLiveActivityDeliveryAt,
            })),
        ),
        Effect.mapError(
          (cause) =>
            new LiveActivityTargetListPersistenceError({
              userId: input.userId,
              cause,
            }),
        ),
      );
    }),

    markDelivery: Effect.fn("relay.live_activities.mark_delivery")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
        "relay.delivery.kind": input.kind,
      });
      yield* client
        .mutation(api.relayPersistence.markLiveActivityDelivery, {
          ...input,
          aggregate:
            input.aggregate === null
              ? null
              : {
                  ...input.aggregate,
                  activities: input.aggregate.activities.map((activity) => ({ ...activity })),
                },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new LiveActivityDeliveryMarkPersistenceError({
                operation: "mark-delivery",
                userId: input.userId,
                deviceId: input.deviceId,
                kind: input.kind,
                cause,
              }),
          ),
        );
    }),

    markStartQueued: Effect.fn("relay.live_activities.mark_start_queued")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
      });
      yield* client.mutation(api.relayPersistence.markLiveActivityStartQueued, input).pipe(
        Effect.mapError(
          (cause) =>
            new LiveActivityDeliveryMarkPersistenceError({
              operation: "mark-start-queued",
              userId: input.userId,
              deviceId: input.deviceId,
              kind: null,
              cause,
            }),
        ),
      );
    }),

    clearStartQueued: Effect.fn("relay.live_activities.clear_start_queued")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
      });
      yield* client.mutation(api.relayPersistence.clearLiveActivityStartQueued, input).pipe(
        Effect.mapError(
          (cause) =>
            new LiveActivityDeliveryMarkPersistenceError({
              operation: "clear-start-queued",
              userId: input.userId,
              deviceId: input.deviceId,
              kind: null,
              cause,
            }),
        ),
      );
    }),

    invalidateDeliveryToken: Effect.fn("relay.live_activities.invalidate_delivery_token")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.mobile.device_id": input.deviceId,
          "relay.delivery.kind": input.kind,
        });
        yield* client
          .mutation(api.relayPersistence.invalidateLiveActivityDeliveryToken, input)
          .pipe(
            Effect.mapError(
              (cause) =>
                new LiveActivityDeliveryMarkPersistenceError({
                  operation: "invalidate-delivery-token",
                  userId: input.userId,
                  deviceId: input.deviceId,
                  kind: input.kind,
                  cause,
                }),
            ),
          );
      },
    ),
  });
});

export const layer = Layer.effect(LiveActivities, make);
