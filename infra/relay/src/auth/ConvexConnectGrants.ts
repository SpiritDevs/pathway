import { api } from "@spiritdevs/backend/convexApi";
import { hashConnectGrantToken } from "@spiritdevs/backend/connectGrants";
import {
  RelayValidatedConnectGrantIdentity,
  type RelayValidatedConnectGrantIdentity as RelayValidatedConnectGrantIdentityType,
} from "@spiritdevs/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RelayConvexClient } from "../db.ts";

const decodeValidatedIdentity = Schema.decodeUnknownEffect(RelayValidatedConnectGrantIdentity);

/**
 * Atomically validates and consumes opaque Convex-issued connect grants through
 * the relay's authenticated control-plane client.
 */
export class ConvexConnectGrants extends Context.Service<
  ConvexConnectGrants,
  {
    readonly validateConnectGrant: (input: {
      readonly grant: string;
      readonly environmentId: string;
    }) => Effect.Effect<RelayValidatedConnectGrantIdentityType | null>;
  }
>()("pathway-relay/auth/ConvexConnectGrants") {}

const make = Effect.gen(function* () {
  const client = yield* RelayConvexClient;

  const validateConnectGrant: ConvexConnectGrants["Service"]["validateConnectGrant"] = Effect.fn(
    "relay.convex_connect_grants.validate",
  )(function* (input) {
    return yield* Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("relay.environment_id", input.environmentId);
      const tokenHash = yield* Effect.tryPromise(() => hashConnectGrantToken(input.grant));
      const result = yield* client.mutation(api.connectGrants.validate, { tokenHash });
      if (result.status !== "accepted" || result.environmentId !== input.environmentId) {
        yield* Effect.annotateCurrentSpan("relay.convex.connect_grant_rejected", true);
        return null;
      }
      return yield* decodeValidatedIdentity({
        environmentId: result.environmentId,
        membershipId: result.membershipId,
        permission: result.permission,
      });
    }).pipe(
      Effect.catch(() =>
        Effect.annotateCurrentSpan("relay.convex.connect_grant_rejected", true).pipe(
          Effect.as(null),
        ),
      ),
    );
  });

  return ConvexConnectGrants.of({ validateConnectGrant });
});

export const layer = Layer.effect(ConvexConnectGrants, make);
