import * as Context from "effect/Context";
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
 * Cloud-sync capability configuration. Absent on every deployment until the
 * Convex backend ships, which leaves Convex service-token exchange and
 * connect-grant verification off.
 */
export interface RelayCloudSyncConfiguration {
  /** Enables `POST /v1/environment/convex-token`. */
  readonly serviceTokensEnabled: boolean;
  /** Convex custom-JWT issuer trusted for connect grants. */
  readonly connectGrantIssuer: string | undefined;
  /** Ed25519 SPKI public key the Convex issuer signs connect grants with. */
  readonly connectGrantPublicKey: string | undefined;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    // Optional so existing deployments and tests keep their current shape while
    // cloud sync is unbuilt; omitting it disables the capability.
    readonly cloudSync?: RelayCloudSyncConfiguration | undefined;
  }
>()("pathway-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));
