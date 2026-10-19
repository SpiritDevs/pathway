// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayObservability } from "./src/observability.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./src/zone.ts";
import ApiLive, { Api } from "./src/worker.ts";

export const RelayGateway = RelayDeploymentConfig.pipe(
  Effect.flatMap(({ relayPublicDomain }) =>
    Cloudflare.Worker("RelayGateway", {
      main: "./src/gateway.ts",
      compatibility: { date: "2026-05-22" },
      domain: relayPublicDomain,
      env: { API: Api },
    }),
  ),
);

export default Alchemy.Stack(
  "PathwayRelay",
  {
    providers: Layer.mergeAll(Axiom.providers(), Cloudflare.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    const gateway = yield* RelayGateway;

    return {
      workerName: gateway.workerName,
      url: gateway.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      mobileTracingUrl: observability.traces.otelTracesEndpoint,
      mobileTracingDataset: observability.traces.name,
      mobileTracingToken: observability.mobileIngestToken.token,
      clientTracingUrl: observability.traces.otelTracesEndpoint,
      clientTracingDataset: observability.traces.name,
      clientTracingToken: observability.clientIngestToken.token,
    };
  }).pipe(Effect.provide(ApiLive)),
);
