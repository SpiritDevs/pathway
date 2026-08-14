import { api } from "@t3tools/backend/convexApi";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";

import { RelayConvexClient } from "../db.ts";

export class DeliveryAttemptRecordPersistenceError extends Schema.TaggedErrorClass<DeliveryAttemptRecordPersistenceError>()(
  "DeliveryAttemptRecordPersistenceError",
  {
    operation: Schema.Literals(["record", "claim-source-job", "complete-source-job"]),
    sourceJobId: Schema.NullOr(Schema.String),
    userId: Schema.NullOr(Schema.String),
    environmentId: Schema.NullOr(Schema.String),
    threadId: Schema.NullOr(Schema.String),
    deviceId: Schema.NullOr(Schema.String),
    kind: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist APNs delivery attempt during ${this.operation}.`;
  }
}

export interface DeliveryAttemptInput {
  readonly userId: string | null;
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly deviceId: string | null;
  readonly kind: string;
  readonly sourceJobId?: string | null;
  readonly token: string | null;
  readonly apnsStatus?: number;
  readonly apnsReason?: string;
  readonly apnsId?: string | null;
  readonly transportError?: string;
}

export interface DeliveryAttemptCompletionInput {
  readonly sourceJobId: string;
  readonly apnsStatus?: number;
  readonly apnsReason?: string;
  readonly apnsId?: string | null;
  readonly transportError?: string;
}

export type DeliverySourceJobClaimResult = "claimed" | "completed" | "in_flight";

export class DeliveryAttempts extends Context.Service<
  DeliveryAttempts,
  {
    readonly record: (
      input: DeliveryAttemptInput,
    ) => Effect.Effect<void, DeliveryAttemptRecordPersistenceError>;
    readonly claimSourceJob: (
      input: DeliveryAttemptInput & { readonly sourceJobId: string },
    ) => Effect.Effect<DeliverySourceJobClaimResult, DeliveryAttemptRecordPersistenceError>;
    readonly completeSourceJob: (
      input: DeliveryAttemptCompletionInput,
    ) => Effect.Effect<void, DeliveryAttemptRecordPersistenceError>;
  }
>()("pathway-relay/agentActivity/DeliveryAttempts") {}

function insertValues(input: DeliveryAttemptInput, id: string, createdAt: string) {
  return {
    id,
    createdAt,
    userId: input.userId,
    environmentId: input.environmentId,
    threadId: input.threadId,
    deviceId: input.deviceId,
    kind: input.kind,
    sourceJobId: input.sourceJobId ?? null,
    tokenSuffix: input.token?.slice(-8) ?? null,
    apnsStatus: input.apnsStatus ?? null,
    apnsReason: input.apnsReason ?? null,
    apnsId: input.apnsId ?? null,
    transportError: input.transportError ?? null,
  };
}

export const make = Effect.gen(function* () {
  const client = yield* RelayConvexClient;
  const crypto = yield* Crypto.Crypto;

  return DeliveryAttempts.of({
    record: Effect.fn("relay.delivery_attempts.record")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.delivery.kind": input.kind,
        ...(input.sourceJobId ? { "relay.delivery.job_id": input.sourceJobId } : {}),
        ...(input.deviceId ? { "relay.mobile.device_id": input.deviceId } : {}),
        ...(input.environmentId ? { "relay.environment_id": input.environmentId } : {}),
        ...(input.threadId ? { "relay.thread_id": input.threadId } : {}),
      });
      yield* Effect.gen(function* () {
        const id = yield* crypto.randomUUIDv4;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* client.mutation(
          api.relayPersistence.recordDeliveryAttempt,
          insertValues(input, id, createdAt),
        );
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DeliveryAttemptRecordPersistenceError({
              operation: "record",
              sourceJobId: input.sourceJobId ?? null,
              userId: input.userId,
              environmentId: input.environmentId,
              threadId: input.threadId,
              deviceId: input.deviceId,
              kind: input.kind,
              cause,
            }),
        ),
      );
    }),
    claimSourceJob: Effect.fn("relay.delivery_attempts.claim_source_job")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.delivery.kind": input.kind,
        "relay.delivery.job_id": input.sourceJobId,
        ...(input.deviceId ? { "relay.mobile.device_id": input.deviceId } : {}),
        ...(input.environmentId ? { "relay.environment_id": input.environmentId } : {}),
        ...(input.threadId ? { "relay.thread_id": input.threadId } : {}),
      });
      return yield* Effect.gen(function* () {
        const id = yield* crypto.randomUUIDv4;
        const now = yield* DateTime.now;
        const createdAt = DateTime.formatIso(now);
        return yield* client.mutation(api.relayPersistence.claimDeliverySourceJob, {
          ...insertValues(input, id, createdAt),
          leaseExpiresBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 10 })),
        });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DeliveryAttemptRecordPersistenceError({
              operation: "claim-source-job",
              sourceJobId: input.sourceJobId,
              userId: input.userId,
              environmentId: input.environmentId,
              threadId: input.threadId,
              deviceId: input.deviceId,
              kind: input.kind,
              cause,
            }),
        ),
      );
    }),
    completeSourceJob: Effect.fn("relay.delivery_attempts.complete_source_job")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.delivery.job_id": input.sourceJobId });
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      yield* client
        .mutation(api.relayPersistence.completeDeliverySourceJob, {
          sourceJobId: input.sourceJobId,
          completedAt,
          apnsStatus: input.apnsStatus ?? null,
          apnsReason: input.apnsReason ?? null,
          apnsId: input.apnsId ?? null,
          transportError: input.transportError ?? null,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeliveryAttemptRecordPersistenceError({
                operation: "complete-source-job",
                sourceJobId: input.sourceJobId,
                userId: null,
                environmentId: null,
                threadId: null,
                deviceId: null,
                kind: null,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(DeliveryAttempts, make);
