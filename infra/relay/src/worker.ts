import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { ConvexHttpClient } from "convex/browser";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";

import { RelayApi } from "@spiritdevs/contracts/relay";

import {
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayCorsPreflightResponse,
  relayDpopClientAuthLayer,
  relayCors,
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  traceRelayHttpRequestWith,
  tokenApi,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import { makeRelayTraceLayer, RelayObservability } from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as FocusNotificationRecorder from "./agentActivity/FocusNotificationRecorder.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as ConvexConnectGrants from "./auth/ConvexConnectGrants.ts";
import * as ConvexJwks from "./auth/ConvexJwks.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as RelayDb from "./db.ts";
import { RelayApnsDeliveryDeadLetterQueue, RelayApnsDeliveryQueue } from "./queues.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";

const webcryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const httpPlatformNotSupportedLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
);

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
export const RELAY_CONVEX_SIGNING_KEY_ID = "pathway-convex-2026-08-01";
const ConvexRelaySigningKey = Alchemy.KeyPair("ConvexRelaySigningKey", {
  algorithm: "ec",
  namedCurve: "P-256",
});
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

export const ApiLive = Api.make(
  {
    main: import.meta.filename,
    compatibility: {
      date: "2026-05-22",
      flags: ["nodejs_compat"],
    },
    // Clerk verification and challenge signing regularly exceed the Free plan's 10 ms ceiling.
    // Keep the paid Worker tightly bounded rather than inheriting its 30-second default.
    limits: { cpuMs: 100 },
    // Public traffic enters through the tiny gateway Worker, which forwards non-preflight
    // requests over this private service binding.
    url: false,
  },
  Effect.gen(function* () {
    //
    // 1. Provision Infrastructure for the Worker to use
    //
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const convexRelaySigningKey = yield* ConvexRelaySigningKey;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const observability = yield* RelayObservability;

    //
    // 2. Create bindings
    //
    const apns = yield* RelayConfiguration.loadApnsCredentials;
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;
    const apnsDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);

    const axiomDatasetName = yield* observability.traces.name;
    const axiomIngestToken = yield* observability.workerIngestToken.token;
    const axiomTracesEndpoint = yield* observability.traces.otelTracesEndpoint;

    const clerkSecretKey = yield* Config.redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.string("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.string("CLERK_JWT_AUDIENCE");
    const convexUrl = yield* Config.nonEmptyString("CONVEX_URL");

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const convexRelayPrivateKey = yield* convexRelaySigningKey.privateKey;
    const convexRelayPublicKey = yield* convexRelaySigningKey.publicKey;

    const managedEndpointTunnelBinding = yield* Cloudflare.Tunnel.ReadWriteTunnel();
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = yield* Cloudflare.DNS.ReadWriteDns(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;

    //
    // 3. Runtime layers and app construction
    //
    const alchemyRuntimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;

    const relaySettings = RelayConfiguration.RelayConfiguration.of({
      relayIssuer: relayPublicOrigin,
      apns,
      apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
      clerkSecretKey,
      clerkPublishableKey,
      clerkJwtAudience,
      cloudMintPrivateKey: yield* cloudMintPrivateKey,
      cloudMintPublicKey: yield* cloudMintPublicKey,
      managedEndpointBaseDomain: yield* managedEndpointZoneName,
      managedEndpointNamespace: stage,
      cloudSync: {
        serviceTokensEnabled: true,
        convexUrl,
        signingKey: {
          keyId: RELAY_CONVEX_SIGNING_KEY_ID,
          privateKey: yield* convexRelayPrivateKey,
          publicKey: yield* convexRelayPublicKey,
        },
        verificationKeys: [
          {
            keyId: RELAY_CONVEX_SIGNING_KEY_ID,
            publicKey: yield* convexRelayPublicKey,
          },
        ],
      },
    });
    const relayConfigurationLayer = Layer.succeed(
      RelayConfiguration.RelayConfiguration,
      relaySettings,
    );
    const relayTokenLayer = RelayTokens.layer.pipe(Layer.provide(relayConfigurationLayer));
    const getConvexControlPlaneToken = Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const relayTokens = yield* RelayTokens.RelayTokens;
      const now = yield* DateTime.now;
      const expiresAt = DateTime.addDuration(now, RelayTokens.RELAY_CONVEX_CONTROL_PLANE_TOKEN_TTL);
      return yield* relayTokens.issueConvexControlPlaneToken({
        jti: yield* crypto.randomUUIDv4,
        issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
      });
    }).pipe(Effect.provide([relayTokenLayer, webcryptoLayer]));

    const relayTraceLayer = Layer.unwrap(
      Effect.all({
        tracesDatasetName: axiomDatasetName,
        tracesEndpoint: axiomTracesEndpoint,
        ingestToken: axiomIngestToken,
      }).pipe(Effect.map(makeRelayTraceLayer)),
    );

    const cloudSyncRuntimeLayer = Layer.empty.pipe(
      Layer.provideMerge(
        RelayDb.RelayConvexClient.layer({
          makeClient: () => new ConvexHttpClient(convexUrl),
          getToken: getConvexControlPlaneToken,
        }),
      ),
      Layer.provideMerge(ConvexJwks.layer),
      Layer.provideMerge(relayConfigurationLayer),
      Layer.provideMerge(webcryptoLayer),
    );

    const runtimeLayer = Layer.empty.pipe(
      Layer.provideMerge(MobileRegistrations.layer),
      Layer.provideMerge(AgentActivityPublisher.layer),
      Layer.provideMerge(EnvironmentConnector.layer),
      Layer.provideMerge(EnvironmentLinker.layer),
      Layer.provideMerge(EnvironmentPublishSignatures.layer),
      Layer.provideMerge(
        ManagedEndpointProvider.layerCloudflareBindings(
          managedEndpointTunnelBinding,
          managedEndpointDnsBinding,
          alchemyRuntimeContext,
        ),
      ),
      Layer.provideMerge(DpopProofs.layer),
      Layer.provideMerge(ConvexConnectGrants.layer),
      Layer.provideMerge(ApnsDeliveries.layer),
      Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
      Layer.provideMerge(
        ApnsDeliveryQueue.layerCloudflareQueues(apnsDeliveryQueueSender, alchemyRuntimeContext),
      ),
      Layer.provideMerge(AgentActivityRows.layer),
      Layer.provideMerge(FocusNotificationRecorder.layer),
      Layer.provideMerge(Devices.layer),
      Layer.provideMerge(EnvironmentCredentials.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          EnvironmentLinks.layer,
          ManagedEndpointAllocations.layer,
          ManagedTunnelLimits.layer,
        ),
      ),
      Layer.provideMerge(LiveActivities.layer),
      Layer.provideMerge(DeliveryAttempts.layer),
      Layer.provideMerge(RelayTokens.layer),
      Layer.provideMerge(cloudSyncRuntimeLayer),
    );

    const appLayer = relayApiLayer.pipe(
      Layer.provideMerge(relayClientAuthLayer),
      Layer.provideMerge(relayDpopClientAuthLayer),
      Layer.provideMerge(relayEnvironmentAuthLayer),
      Layer.provide(runtimeLayer),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      apnsDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.apn_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.apn_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(runtimeLayer),
        ),
    );

    const MAX_PRUNE_BATCHES_PER_RUN = 10;
    const drainPruneBatches = <E, R>(
      prune: Effect.Effect<number, E, R>,
      batchSize: number,
      batchesRemaining = MAX_PRUNE_BATCHES_PER_RUN,
    ): Effect.Effect<void, E, R> =>
      prune.pipe(
        Effect.flatMap((deleted) =>
          deleted === batchSize && batchesRemaining > 1
            ? drainPruneBatches(prune, batchSize, batchesRemaining - 1)
            : Effect.void,
        ),
      );

    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          Effect.all([
            drainPruneBatches(DpopProofs.pruneExpiredBatch, DpopProofs.DPOP_PROOF_PRUNE_BATCH_SIZE),
            // Terminal thread rows are kept briefly so finished agents show as
            // Done/Failed in the Live Activity; sweep them once they age out.
            drainPruneBatches(
              AgentActivityRows.pruneTerminalBatch({
                updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
              }),
              AgentActivityRows.AGENT_ACTIVITY_PRUNE_BATCH_SIZE,
            ),
          ]),
        ),
        Effect.withSpan("relay.cron.prune_expired_state"),
        Effect.provide(runtimeLayer),
      ),
    );

    const fetch = Layer.merge(
      Layer.mergeAll(
        HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(appLayer),
        ),
        HttpApiScalar.layer(RelayApi, { path: "/docs" }),
        relayDocsRedirectRoute,
        ConvexJwks.route,
      ).pipe(Layer.provide([Etag.layerWeak, httpPlatformNotSupportedLayer, relayCors])),
      relayNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      withoutCapturedParentSpan,
      Effect.flatMap((httpEffect) =>
        HttpServerRequest.HttpServerRequest.pipe(
          Effect.flatMap((request) =>
            request.method === "OPTIONS"
              ? Effect.succeed(relayCorsPreflightResponse())
              : traceRelayHttpRequestWith(
                  httpEffect.pipe(Effect.provide(runtimeLayer)),
                  relayTraceLayer,
                ),
          ),
        ),
      ),
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.Workers.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.Queues.WriteQueueBinding),
        Layer.provideMerge(Cloudflare.Queues.EventSourceLive),
        Layer.provideMerge(Cloudflare.Tunnel.ReadWriteTunnelBinding),
        Layer.provideMerge(Cloudflare.DNS.ReadWriteDnsHttp),
      ),
    ),
  ),
);

export default ApiLive;
