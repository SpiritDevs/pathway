import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

/**
 * APNs is optional so operators can run web, desktop, and agent-control relay features without an
 * Apple Developer account. Existing deployments remain enabled by default; disabling it avoids
 * reading any Apple credential variables.
 */
export const loadApnsCredentials = Effect.gen(function* () {
  const enabled = yield* Config.boolean("APNS_ENABLED").pipe(Config.withDefault(true));
  if (!enabled) return undefined;
  return {
    environment: yield* Config.schema(ApnsEnvironment, "APNS_ENVIRONMENT"),
    teamId: yield* Config.string("APNS_TEAM_ID"),
    keyId: yield* Config.string("APNS_KEY_ID"),
    bundleId: yield* Config.string("APNS_BUNDLE_ID"),
    privateKey: yield* Config.redacted("APNS_PRIVATE_KEY"),
  } satisfies ApnsCredentials;
});

/**
 * Cloud-sync capability configuration. Tests and legacy embedding contexts may
 * omit it; deployed relays configure it from the Alchemy-managed P-256 key and
 * their selected Convex deployment.
 */
export interface RelayCloudSyncConfiguration {
  /** Enables `POST /v1/environment/convex-token`. */
  readonly serviceTokensEnabled: boolean;
  /** Convex deployment used for relay-owned durable state. */
  readonly convexUrl: string;
  /** Current P-256 key used for every relay-issued `pathway-convex` token. */
  readonly signingKey: {
    readonly keyId: string;
    readonly privateKey: Redacted.Redacted<string>;
    readonly publicKey: string;
  };
  /** Current key first, followed by overlap keys retained during rotation. */
  readonly verificationKeys: ReadonlyArray<{
    readonly keyId: string;
    readonly publicKey: string;
  }>;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials | undefined;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    // Optional for legacy embedding contexts and focused tests. The deployed
    // worker always provides it; omission fails all Convex token issuance closed.
    readonly cloudSync?: RelayCloudSyncConfiguration | undefined;
  }
>()("pathway-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));
