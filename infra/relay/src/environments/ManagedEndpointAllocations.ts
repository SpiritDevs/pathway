import type { RelayManagedEndpoint } from "@spiritdevs/contracts/relay";
import { api } from "@spiritdevs/backend/convexApi";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RelayConvexClient } from "../db.ts";
import { isManagedEndpointHostname, managedEndpointForHostname } from "../deploymentConfig.ts";
import { ManagedTunnelLimitExceeded } from "./ManagedTunnelLimits.ts";

// The persisted column names predate Cyndrbase Connect.
export interface ManagedEndpointAllocation {
  readonly userId: string;
  readonly environmentId: string;
  readonly hostname: string;
  /** The Connect endpoint ID. */
  readonly tunnelId: string | null;
  /** Reserved per environment so hostnames stay unique. */
  readonly tunnelName: string;
  /** The connector token slot, written only with `swapTokenSlot`. */
  readonly dnsRecordId: string | null;
  readonly readyAt: string | null;
  readonly updatedAt: string;
}

export function resolveReadyManagedEndpoint(input: {
  readonly allocation: ManagedEndpointAllocation;
  readonly baseDomain: string | undefined;
}): RelayManagedEndpoint | null {
  if (
    !input.baseDomain ||
    input.allocation.readyAt === null ||
    input.allocation.tunnelId === null ||
    input.allocation.dnsRecordId === null ||
    !isManagedEndpointHostname(input.allocation.hostname, input.baseDomain)
  ) {
    return null;
  }
  return managedEndpointForHostname(input.allocation.hostname);
}

export class ManagedEndpointAllocationPersistenceError extends Schema.TaggedErrorClass<ManagedEndpointAllocationPersistenceError>()(
  "ManagedEndpointAllocationPersistenceError",
  {
    operation: Schema.Literals([
      "get",
      "reserve",
      "record-tunnel",
      "swap-token-slot",
      "mark-ready",
      "remove",
      "remove-with-token-slot",
    ]),
    stage: Schema.Literals(["database-request", "resolve-reservation"]),
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint allocation '${this.operation}' failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

interface ManagedEndpointAllocationKey {
  readonly userId: string;
  readonly environmentId: string;
}

interface ReserveManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly hostname: string;
  readonly tunnelName: string;
}

interface RecordManagedEndpointTunnelInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
}

interface SwapManagedEndpointTokenSlotInput extends ManagedEndpointAllocationKey {
  readonly expected: string | null;
  readonly next: string;
}

interface RemoveManagedEndpointAllocationWithTokenSlotInput extends ManagedEndpointAllocationKey {
  readonly tokenSlot: string;
}

export class ManagedEndpointAllocations extends Context.Service<
  ManagedEndpointAllocations,
  {
    readonly get: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<ManagedEndpointAllocation | null, ManagedEndpointAllocationPersistenceError>;
    readonly reserve: (
      input: ReserveManagedEndpointAllocationInput,
    ) => Effect.Effect<
      ManagedEndpointAllocation,
      ManagedEndpointAllocationPersistenceError | ManagedTunnelLimitExceeded
    >;
    readonly recordTunnel: (
      input: RecordManagedEndpointTunnelInput,
    ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
    /**
     * Sets the token slot to `next` only while it still holds `expected`, in one transaction.
     * Returns what the slot holds afterwards, or null when there is no allocation.
     */
    readonly swapTokenSlot: (
      input: SwapManagedEndpointTokenSlotInput,
    ) => Effect.Effect<string | null, ManagedEndpointAllocationPersistenceError>;
    readonly markReady: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
    readonly remove: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
    /** Deletes the allocation only while its token slot still holds `tokenSlot`. */
    readonly removeWithTokenSlot: (
      input: RemoveManagedEndpointAllocationWithTokenSlotInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
  }
>()("pathway-relay/environments/ManagedEndpointAllocations") {}

export const make = Effect.gen(function* () {
  const client = yield* RelayConvexClient;

  return ManagedEndpointAllocations.of({
    get: Effect.fn("relay.managed_endpoint_allocations.get")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      return yield* client.query(api.relayPersistence.getManagedEndpointAllocation, input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointAllocationPersistenceError({
              operation: "get",
              stage: "database-request",
              ...input,
              cause,
            }),
        ),
      );
    }),
    reserve: Effect.fn("relay.managed_endpoint_allocations.reserve")(function* (
      input: ReserveManagedEndpointAllocationInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const result = yield* client
        .mutation(api.relayPersistence.reserveManagedEndpointAllocation, { ...input, now })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "reserve",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
      if (result.status === "limit_exceeded") {
        return yield* new ManagedTunnelLimitExceeded({
          userId: input.userId,
          environmentId: input.environmentId,
          maxTunnels: result.maxTunnels,
          activeTunnels: result.activeTunnels,
        });
      }
      return result.allocation;
    }),
    recordTunnel: Effect.fn("relay.managed_endpoint_allocations.record_tunnel")(function* (
      input: RecordManagedEndpointTunnelInput,
    ) {
      yield* client
        .mutation(api.relayPersistence.recordManagedEndpointTunnel, {
          ...input,
          now: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "record-tunnel",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    swapTokenSlot: Effect.fn("relay.managed_endpoint_allocations.swap_token_slot")(function* (
      input: SwapManagedEndpointTokenSlotInput,
    ) {
      return yield* client
        .mutation(api.relayPersistence.swapManagedEndpointTokenSlot, {
          ...input,
          now: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "swap-token-slot",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),
    markReady: Effect.fn("relay.managed_endpoint_allocations.mark_ready")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* client.mutation(api.relayPersistence.markManagedEndpointReady, { ...input, now }).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointAllocationPersistenceError({
              operation: "mark-ready",
              stage: "database-request",
              ...input,
              cause,
            }),
        ),
      );
    }),
    remove: Effect.fn("relay.managed_endpoint_allocations.remove")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      yield* client.mutation(api.relayPersistence.removeManagedEndpointAllocation, input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointAllocationPersistenceError({
              operation: "remove",
              stage: "database-request",
              ...input,
              cause,
            }),
        ),
      );
    }),
    removeWithTokenSlot: Effect.fn("relay.managed_endpoint_allocations.remove_with_token_slot")(
      function* (input: RemoveManagedEndpointAllocationWithTokenSlotInput) {
        return yield* client
          .mutation(api.relayPersistence.removeManagedEndpointAllocationWithTokenSlot, input)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointAllocationPersistenceError({
                  operation: "remove-with-token-slot",
                  stage: "database-request",
                  userId: input.userId,
                  environmentId: input.environmentId,
                  cause,
                }),
            ),
          );
      },
    ),
  });
});

export const layer = Layer.effect(ManagedEndpointAllocations, make);
