import { PortSchema } from "@spiritdevs/contracts";
import { RelayManagedEndpointRuntimeConfig } from "@spiritdevs/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const CLOUD_MINT_PUBLIC_KEY = "cloud-mint-ed25519-public-key";
export const CLOUD_ENDPOINT_RUNTIME_CONFIG = "cloud-endpoint-runtime-config";
export const CLOUD_MANAGED_TUNNEL_LOCAL_PORT = "cloud-managed-tunnel-local-port";
export const CLOUD_LINKED_USER_ID = "cloud-linked-user-id";
/** The desktop app's signed-in account; owns the environment while it is not linked. */
export const CLOUD_OWNER_USER_ID = "cloud-owner-user-id";
export const RELAY_URL_SECRET = "cloud-relay-url";
export const RELAY_ISSUER_SECRET = "cloud-relay-issuer";
export const RELAY_ENVIRONMENT_CREDENTIAL_SECRET = "cloud-relay-environment-credential";
export const PUBLISH_AGENT_ACTIVITY_SECRET = "cloud-publish-agent-activity";
/** The managed tunnel's public `https://` base URL, as the relay assigned it at link time. */
export const CLOUD_MANAGED_ENDPOINT_URL = "cloud-managed-endpoint-url";

export const encodeEndpointRuntimeConfigJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);

export const decodeRuntimeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);

export const encodeManagedTunnelLocalPort = Schema.encodeEffect(Schema.fromJsonString(PortSchema));

export const decodeManagedTunnelLocalPort = Schema.decodeUnknownOption(
  Schema.fromJsonString(PortSchema),
);

/**
 * The environment's public Pathway Connect base URL, or null when no managed
 * tunnel is configured. Both the tunnel's runtime config and the URL the relay
 * assigned must be present: an unlinked or publish-only environment has none.
 */
export const readManagedEndpointPublicUrl = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<string | null> =>
  Effect.all([
    secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
    secrets.get(CLOUD_MANAGED_ENDPOINT_URL),
  ]).pipe(
    Effect.map(([runtimeConfig, url]) =>
      Option.isSome(runtimeConfig) && Option.isSome(url) && url.value.length > 0
        ? new TextDecoder().decode(url.value)
        : null,
    ),
    Effect.orElseSucceed(() => null),
  );
