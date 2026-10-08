import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { EnvironmentId } from "@spiritdevs/contracts";
import type {
  RelayManagedEndpoint,
  RelayManagedEndpointRuntimeConfig,
} from "@spiritdevs/contracts/relay";

import * as RelayConfiguration from "../Config.ts";
import {
  managedEndpointDigestInput,
  managedEndpointForHostname,
  managedEndpointHostname,
  managedEndpointTunnelName,
} from "../deploymentConfig.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

export class ManagedEndpointProvisioningNotConfigured extends Schema.TaggedErrorClass<ManagedEndpointProvisioningNotConfigured>()(
  "ManagedEndpointProvisioningNotConfigured",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    missingSettings: Schema.Array(
      Schema.Literals([
        "managedEndpointBaseDomain",
        "managedEndpointNamespace",
        "cyndrbaseConnect",
      ]),
    ),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning is not configured for user '${this.userId}', environment '${this.environmentId}': missing ${this.missingSettings.join(", ")}`;
  }
}

const ManagedEndpointProvisioningStage = Schema.Literals([
  "derive-environment-hash",
  "reserve-allocation",
  "ensure-endpoint",
  "record-endpoint",
  "create-connector-token",
  "record-connector-token",
  "mark-allocation-ready",
]);

export class ManagedEndpointProvisioningFailed extends Schema.TaggedErrorClass<ManagedEndpointProvisioningFailed>()(
  "ManagedEndpointProvisioningFailed",
  {
    stage: ManagedEndpointProvisioningStage,
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    endpointId: Schema.optionalKey(Schema.String),
    connectorTokenId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

const ManagedEndpointDeprovisioningStage = Schema.Literals([
  "load-allocation",
  "claim-deprovision",
  "revoke-connector-token",
  "remove-endpoint",
  "remove-allocation",
]);

export class ManagedEndpointDeprovisioningFailed extends Schema.TaggedErrorClass<ManagedEndpointDeprovisioningFailed>()(
  "ManagedEndpointDeprovisioningFailed",
  {
    stage: ManagedEndpointDeprovisioningStage,
    userId: Schema.String,
    environmentId: Schema.String,
    endpointId: Schema.optionalKey(Schema.String),
    connectorTokenId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed endpoint deprovisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export type ManagedEndpointProviderError =
  | ManagedEndpointProvisioningNotConfigured
  | ManagedEndpointProvisioningFailed
  | ManagedTunnelLimits.ManagedTunnelLimitExceeded;

export interface ManagedEndpointProvisioningResult {
  readonly endpoint: RelayManagedEndpoint;
  readonly runtime: RelayManagedEndpointRuntimeConfig;
}

export type ManagedEndpointDeprovisionTarget = ManagedEndpointAllocations.ManagedEndpointAllocation;

export class ManagedEndpointProvider extends Context.Service<
  ManagedEndpointProvider,
  {
    readonly provision: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
    /**
     * Captures the allocation generation owned by an unlink before its link
     * revocation commits. Passing this target to `deprovision` prevents a
     * concurrent relink from having its newer allocation torn down.
     */
    readonly prepareDeprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<
      ManagedEndpointDeprovisionTarget | null,
      ManagedEndpointDeprovisioningFailed
    >;
    readonly deprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly target?: ManagedEndpointDeprovisionTarget | null;
    }) => Effect.Effect<void, ManagedEndpointDeprovisioningFailed>;
  }
>()("pathway-relay/environments/ManagedEndpointProvider") {}

/** A failed Cyndrbase Connect `EndpointService` call; `code` is the Connect error code. */
export class CyndrbaseConnectRpcError extends Schema.TaggedErrorClass<CyndrbaseConnectRpcError>()(
  "CyndrbaseConnectRpcError",
  {
    method: Schema.String,
    code: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Cyndrbase Connect ${this.method} failed: ${this.code}`;
  }
}

const ConnectEndpoint = Schema.Struct({ endpoint: Schema.Struct({ id: Schema.String }) });
const ConnectToken = Schema.Struct({
  connectorToken: Schema.Struct({ id: Schema.String }),
  token: Schema.String,
});
const ConnectPlan = Schema.Struct({ plan: Schema.Struct({ id: Schema.String }) });
const ConnectErrorBody = Schema.Struct({ code: Schema.String });
const ConnectEmpty = Schema.Struct({});

const requireSettings = Effect.fnUntraced(function* (
  settings: RelayConfiguration.RelayConfiguration["Service"],
  input: { readonly userId: string; readonly environmentId: string },
) {
  const { managedEndpointBaseDomain: baseDomain, managedEndpointNamespace: namespace } = settings;
  const connect = settings.cyndrbaseConnect;
  if (!baseDomain || !namespace || !connect) {
    return yield* new ManagedEndpointProvisioningNotConfigured({
      ...input,
      missingSettings: [
        ...(baseDomain ? [] : (["managedEndpointBaseDomain"] as const)),
        ...(namespace ? [] : (["managedEndpointNamespace"] as const)),
        ...(connect ? [] : (["cyndrbaseConnect"] as const)),
      ],
    });
  }
  return { baseDomain, namespace, connect };
});

// The allocation's dnsRecordId column (named before Connect) holds the current connector
// token ID followed by replaced token IDs still awaiting revocation, space-separated.
const recordedTokenIds = (dnsRecordId: string | null) =>
  dnsRecordId?.split(" ").filter((id) => id.length > 0) ?? [];

const isNotFound = (error: CyndrbaseConnectRpcError) => error.code === "not_found";
const isConnectRpcError = Schema.is(CyndrbaseConnectRpcError);

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;

  const rpc = <A>(
    connect: RelayConfiguration.CyndrbaseConnectConfiguration,
    method: string,
    body: Record<string, unknown>,
    schema: Schema.Decoder<A>,
  ) =>
    HttpClientRequest.post(`${connect.apiUrl}/cyndrbase.connect.v1.EndpointService/${method}`).pipe(
      HttpClientRequest.bearerToken(Redacted.value(connect.adminKey)),
      HttpClientRequest.bodyJson(body),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap((response) =>
        response.status === 200
          ? HttpClientResponse.schemaBodyJson(schema)(response)
          : HttpClientResponse.schemaBodyJson(ConnectErrorBody)(response).pipe(
              Effect.flatMap(({ code }) =>
                Effect.fail(new CyndrbaseConnectRpcError({ method, code })),
              ),
            ),
      ),
      Effect.catchIf(
        (cause) => !isConnectRpcError(cause),
        (cause) =>
          Effect.fail(new CyndrbaseConnectRpcError({ method, code: "unavailable", cause })),
      ),
    );

  // Plan/Apply keys derive from the target, so a retried call replays the original outcome.
  const revokeConnectorToken = (
    connect: RelayConfiguration.CyndrbaseConnectConfiguration,
    tokenId: string,
  ) =>
    rpc(
      connect,
      "PlanRevokeConnectorToken",
      { tokenId, idempotencyKey: `plan-revoke:${tokenId}` },
      ConnectPlan,
    ).pipe(
      Effect.flatMap(({ plan }) =>
        rpc(
          connect,
          "ApplyRevokeConnectorToken",
          { planId: plan.id, idempotencyKey: `apply-revoke:${tokenId}` },
          ConnectEmpty,
        ),
      ),
      Effect.asVoid,
      Effect.catchIf(isNotFound, () => Effect.void),
    );

  const removeEndpoint = (
    connect: RelayConfiguration.CyndrbaseConnectConfiguration,
    endpointId: string,
  ) =>
    rpc(
      connect,
      "PlanEndpointChange",
      { endpoint: { id: endpointId }, remove: true, idempotencyKey: `plan-remove:${endpointId}` },
      ConnectPlan,
    ).pipe(
      Effect.flatMap(({ plan }) =>
        rpc(
          connect,
          "ApplyEndpointChange",
          { planId: plan.id, idempotencyKey: `apply-remove:${endpointId}` },
          ConnectEmpty,
        ),
      ),
      Effect.asVoid,
      Effect.catchIf(isNotFound, () => Effect.void),
    );

  const prepareDeprovision = Effect.fn("relay.managed_endpoint_provider.prepare_deprovision")(
    function* (input: { readonly userId: string; readonly environmentId: string }) {
      return yield* allocations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDeprovisioningFailed({
              ...input,
              stage: "load-allocation",
              cause,
            }),
        ),
      );
    },
  );

  return ManagedEndpointProvider.of({
    prepareDeprovision,
    deprovision: Effect.fn("relay.managed_endpoint_provider.deprovision")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.user_id": input.userId,
        "relay.environment_id": input.environmentId,
      });
      const allocation =
        input.target === undefined ? yield* prepareDeprovision(input) : input.target;
      if (allocation === null) {
        return;
      }
      const key = { userId: input.userId, environmentId: input.environmentId };
      const endpointId = allocation.tunnelId;
      const connectorTokenIds = recordedTokenIds(allocation.dnsRecordId);
      const failed = (stage: typeof ManagedEndpointDeprovisioningStage.Type) => (cause: unknown) =>
        new ManagedEndpointDeprovisioningFailed({
          ...key,
          stage,
          ...(endpointId === null ? {} : { endpointId }),
          ...(allocation.dnsRecordId === null ? {} : { connectorTokenId: allocation.dnsRecordId }),
          cause,
        });
      const claimedAt = yield* allocations
        .claimDeprovision({ ...key, updatedAt: allocation.updatedAt })
        .pipe(Effect.mapError(failed("claim-deprovision")));
      if (claimedAt === null) {
        return;
      }
      // Without Connect settings this relay cannot have issued anything to clean up.
      const connect = config.cyndrbaseConnect;
      if (connect) {
        yield* Effect.forEach(connectorTokenIds, (id) => revokeConnectorToken(connect, id), {
          discard: true,
        }).pipe(Effect.mapError(failed("revoke-connector-token")));
      }
      if (connect && endpointId !== null) {
        yield* removeEndpoint(connect, endpointId).pipe(Effect.mapError(failed("remove-endpoint")));
      }
      yield* allocations
        .removeClaimed({ ...key, updatedAt: claimedAt })
        .pipe(Effect.mapError(failed("remove-allocation")));
    }),
    provision: Effect.fn("relay.managed_endpoint_provider.provision")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.user_id": input.userId,
        "relay.environment_id": input.environmentId,
      });
      const settings = yield* requireSettings(config, input);
      const key = { userId: input.userId, environmentId: input.environmentId };
      const environmentHash = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            managedEndpointDigestInput(settings.namespace, input.userId, input.environmentId),
          ),
        )
        .pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                ...key,
                stage: "derive-environment-hash",
                cause,
              }),
          ),
        );
      const requestedHostname = managedEndpointHostname(
        settings.namespace,
        settings.baseDomain,
        environmentHash,
      );
      const allocation = yield* allocations
        .reserve({
          ...key,
          hostname: requestedHostname,
          tunnelName: managedEndpointTunnelName(settings.namespace, environmentHash),
        })
        .pipe(
          Effect.catchTag("ManagedEndpointAllocationPersistenceError", (cause) =>
            Effect.fail(
              new ManagedEndpointProvisioningFailed({
                ...key,
                stage: "reserve-allocation",
                hostname: requestedHostname,
                cause,
              }),
            ),
          ),
        );
      const { hostname } = allocation;
      const failed =
        (
          stage: typeof ManagedEndpointProvisioningStage.Type,
          ids: { readonly endpointId?: string; readonly connectorTokenId?: string } = {},
        ) =>
        (cause: unknown) =>
          new ManagedEndpointProvisioningFailed({ ...key, stage, hostname, ...ids, cause });

      // The endpoint record outlives connectors. It is created once per allocation and
      // recreated only when the edge no longer knows it.
      const recorded =
        allocation.tunnelId === null
          ? null
          : yield* rpc(
              settings.connect,
              "GetEndpoint",
              { endpointId: allocation.tunnelId },
              ConnectEndpoint,
            ).pipe(
              Effect.map(({ endpoint }) => endpoint.id),
              Effect.catchIf(isNotFound, () => Effect.succeed(null)),
              Effect.mapError(failed("ensure-endpoint", { endpointId: allocation.tunnelId })),
            );
      const endpointId =
        recorded ??
        (yield* rpc(
          settings.connect,
          "CreateEndpoint",
          {
            hostname,
            policy: { access: "ACCESS_KIND_PUBLIC" },
            traffic: "TRAFFIC_KIND_HTTP",
            idempotencyKey: `endpoint:${hostname}:${allocation.updatedAt}`,
          },
          ConnectEndpoint,
        ).pipe(
          Effect.map(({ endpoint }) => endpoint.id),
          Effect.mapError(failed("ensure-endpoint")),
        ));
      if (endpointId !== allocation.tunnelId) {
        yield* allocations
          .recordTunnel({ ...key, tunnelId: endpointId })
          .pipe(Effect.mapError(failed("record-endpoint", { endpointId })));
      }

      // Every provision rotates the connector token: issue, record, then revoke what it
      // replaced. The key names the replaced token, so a retry after a failed record reuses
      // the same new token while the old one stays tracked. A failed revocation also stays
      // recorded, for the next provision or unlink to retry.
      const replacedTokenIds = recordedTokenIds(allocation.dnsRecordId);
      const token = yield* rpc(
        settings.connect,
        "CreateConnectorToken",
        {
          endpointIds: [endpointId],
          idempotencyKey: `token:${endpointId}:${replacedTokenIds[0] ?? "none"}`,
        },
        ConnectToken,
      ).pipe(Effect.mapError(failed("create-connector-token", { endpointId })));
      const connectorTokenId = token.connectorToken.id;
      const replaced = replacedTokenIds.filter((id) => id !== connectorTokenId);
      yield* allocations
        .recordDns({ ...key, dnsRecordId: [connectorTokenId, ...replaced].join(" ") })
        .pipe(Effect.mapError(failed("record-connector-token", { endpointId, connectorTokenId })));
      yield* allocations
        .markReady(key)
        .pipe(Effect.mapError(failed("mark-allocation-ready", { endpointId, connectorTokenId })));
      const unrevoked = yield* Effect.forEach(replaced, (id) =>
        revokeConnectorToken(settings.connect, id).pipe(
          Effect.as(null),
          Effect.catch((error) =>
            Effect.logWarning("Replaced connector token is still live; will retry revocation", {
              connectorTokenId: id,
              code: error.code,
            }).pipe(Effect.as(id)),
          ),
        ),
      ).pipe(Effect.map((ids) => ids.filter((id) => id !== null)));
      if (unrevoked.length < replaced.length) {
        yield* allocations
          .recordDns({ ...key, dnsRecordId: [connectorTokenId, ...unrevoked].join(" ") })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not forget revoked connector tokens; will retry", { error }),
            ),
          );
      }

      return {
        endpoint: managedEndpointForHostname(hostname),
        runtime: {
          environmentId: EnvironmentId.make(input.environmentId),
          providerKind: "pathway_relay",
          connectorToken: token.token,
          edgeUrl: settings.connect.edgeUrl,
          endpointId,
        },
      } satisfies ManagedEndpointProvisioningResult;
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);
