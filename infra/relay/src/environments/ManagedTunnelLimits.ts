import { api } from "@t3tools/backend/convexApi";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RelayConvexClient } from "../db.ts";

/**
 * Managed tunnels a user may hold at once unless a row in
 * `relay_managed_tunnel_limits` overrides it for that user.
 */
export const DEFAULT_MANAGED_TUNNEL_LIMIT = 3;

export class ManagedTunnelLimitPersistenceError extends Schema.TaggedErrorClass<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals(["load-limit", "count-tunnels"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ManagedTunnelLimitExceeded extends Schema.TaggedErrorClass<ManagedTunnelLimitExceeded>()(
  "ManagedTunnelLimitExceeded",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    maxTunnels: Schema.Number,
    activeTunnels: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed tunnel limit reached for user '${this.userId}': ${this.activeTunnels} of ${this.maxTunnels} tunnels in use`;
  }
}

export class ManagedTunnelLimits extends Context.Service<
  ManagedTunnelLimits,
  {
    readonly ensureCapacity: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<void, ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError>;
  }
>()("pathway-relay/environments/ManagedTunnelLimits") {}

export const make = Effect.gen(function* () {
  const client = yield* RelayConvexClient;

  return ManagedTunnelLimits.of({
    ensureCapacity: Effect.fn("relay.managed_tunnel_limits.ensure_capacity")(function* (input) {
      const capacity = yield* client
        .query(api.relayPersistence.ensureManagedTunnelCapacity, input)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedTunnelLimitPersistenceError({
                operation: "count-tunnels",
                userId: input.userId,
                cause,
              }),
          ),
        );
      if (!capacity.allowed) {
        return yield* new ManagedTunnelLimitExceeded({
          userId: input.userId,
          environmentId: input.environmentId,
          maxTunnels: capacity.maxTunnels,
          activeTunnels: capacity.activeTunnels,
        });
      }
    }),
  });
});

export const layer = Layer.effect(ManagedTunnelLimits, make);
