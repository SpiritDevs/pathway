import { relayEs256PublicJwk, type RelayEs256PublicJwk } from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as RelayConfiguration from "../Config.ts";

export interface RelayConvexJwksDocument {
  readonly keys: ReadonlyArray<RelayEs256PublicJwk>;
}

export class ConvexJwks extends Context.Service<ConvexJwks, RelayConvexJwksDocument>()(
  "pathway-relay/auth/ConvexJwks",
) {}

export const layer = Layer.effect(
  ConvexJwks,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const verificationKeys = config.cloudSync?.verificationKeys ?? [];
    const keys = yield* Effect.forEach(verificationKeys, relayEs256PublicJwk);
    return ConvexJwks.of({ keys });
  }),
);

export const route = HttpRouter.add(
  "GET",
  "/.well-known/jwks.json",
  Effect.gen(function* () {
    const jwks = yield* ConvexJwks;
    return HttpServerResponse.jsonUnsafe(jwks, {
      headers: {
        "cache-control": "public, max-age=300, stale-while-revalidate=300",
        "content-type": "application/json",
      },
    });
  }),
);
