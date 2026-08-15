import type {
  RelayClientDeviceRecord,
  RelayDeviceRegistrationRequest,
} from "@spiritdevs/contracts/relay";
import { api } from "@spiritdevs/backend/convexApi";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RelayConvexClient } from "../db.ts";

export class DeviceRegistrationPersistenceError extends Schema.TaggedErrorClass<DeviceRegistrationPersistenceError>()(
  "DeviceRegistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    stage: Schema.Literals(["claim-push-token", "claim-push-to-start-token", "upsert-device"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist mobile device registration for ${this.userId}/${this.deviceId} during ${this.stage}.`;
  }
}

export class DeviceUnregistrationPersistenceError extends Schema.TaggedErrorClass<DeviceUnregistrationPersistenceError>()(
  "DeviceUnregistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    stage: Schema.Literals(["delete-live-activity", "delete-device"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister mobile device ${this.userId}/${this.deviceId} during ${this.stage}.`;
  }
}

export class DeviceListPersistenceError extends Schema.TaggedErrorClass<DeviceListPersistenceError>()(
  "DeviceListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list mobile devices for ${this.userId}.`;
  }
}

export class Devices extends Context.Service<
  Devices,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly registration: RelayDeviceRegistrationRequest;
    }) => Effect.Effect<void, DeviceRegistrationPersistenceError>;
    readonly unregister: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<void, DeviceUnregistrationPersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<RelayClientDeviceRecord>, DeviceListPersistenceError>;
  }
>()("pathway-relay/agentActivity/Devices") {}

export const make = Effect.gen(function* () {
  const client = yield* RelayConvexClient;

  return Devices.of({
    register: Effect.fn("relay.devices.register")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.registration.deviceId,
      });
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const registration = input.registration;
      yield* client
        .mutation(api.relayPersistence.registerDevice, {
          userId: input.userId,
          now: updatedAt,
          registration: {
            deviceId: registration.deviceId,
            label: registration.label,
            platform: registration.platform,
            iosMajorVersion: registration.iosMajorVersion,
            preferences: registration.preferences,
            ...(registration.appVersion === undefined
              ? {}
              : { appVersion: registration.appVersion }),
            ...(registration.bundleId === undefined ? {} : { bundleId: registration.bundleId }),
            ...(registration.apsEnvironment === undefined
              ? {}
              : { apsEnvironment: registration.apsEnvironment }),
            ...(registration.pushToken === undefined ? {} : { pushToken: registration.pushToken }),
            ...(registration.pushToStartToken === undefined
              ? {}
              : { pushToStartToken: registration.pushToStartToken }),
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeviceRegistrationPersistenceError({
                userId: input.userId,
                deviceId: registration.deviceId,
                stage: "upsert-device",
                cause,
              }),
          ),
        );
    }),
    unregister: Effect.fn("relay.devices.unregister")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
      });
      yield* client.mutation(api.relayPersistence.unregisterDevice, input).pipe(
        Effect.mapError(
          (cause) =>
            new DeviceUnregistrationPersistenceError({
              userId: input.userId,
              deviceId: input.deviceId,
              stage: "delete-live-activity",
              cause,
            }),
        ),
      );
    }),
    listForUser: Effect.fn("relay.devices.listForUser")(function* (input) {
      return yield* client
        .query(api.relayPersistence.listDevices, input)
        .pipe(
          Effect.mapError(
            (cause) => new DeviceListPersistenceError({ userId: input.userId, cause }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(Devices, make);
