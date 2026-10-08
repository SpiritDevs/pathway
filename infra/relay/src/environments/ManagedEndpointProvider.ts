import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  "revoke-retired-tokens",
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
    /**
     * Records that the environment's connector registered with `connectorTokenId`, which
     * retires the tokens it replaced. False when the token is neither current nor pending.
     */
    readonly confirm: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly connectorTokenId: string;
    }) => Effect.Effect<boolean, ManagedEndpointProviderError>;
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

// Connector token state, kept as JSON in the allocation's dnsRecordId column (named before
// Connect) and written only with compare-and-set. `current` is the token the environment
// confirmed it registered with; `pending` was issued but not yet confirmed; `retired` tokens
// were replaced and still need revoking. A token is revoked only after a committed write
// retired it, so a revoked token can never become current or pending again.
const TokenState = Schema.Struct({
  current: Schema.NullOr(Schema.String),
  pending: Schema.NullOr(Schema.String),
  retired: Schema.Array(Schema.String),
});
type TokenState = typeof TokenState.Type;
const decodeTokenState = Schema.decodeUnknownOption(Schema.fromJsonString(TokenState));
const encodeTokenState = Schema.encodeSync(Schema.fromJsonString(TokenState));
// A value written before this format (a cloudflared DNS record ID) can only be retired.
const readTokenState = (dnsRecordId: string | null): TokenState =>
  dnsRecordId === null
    ? { current: null, pending: null, retired: [] }
    : Option.getOrElse(decodeTokenState(dnsRecordId), () => ({
        current: null,
        pending: null,
        retired: [dnsRecordId],
      }));
const MAX_RETIRED_TOKENS = 2;
const MAX_WRITE_ATTEMPTS = 5;

export class ManagedEndpointTokenStateConflict extends Schema.TaggedErrorClass<ManagedEndpointTokenStateConflict>()(
  "ManagedEndpointTokenStateConflict",
  {},
) {}
export class ManagedEndpointRetiredTokensOutstanding extends Schema.TaggedErrorClass<ManagedEndpointRetiredTokensOutstanding>()(
  "ManagedEndpointRetiredTokensOutstanding",
  { connectorTokenIds: Schema.Array(Schema.String) },
) {}

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

  type AllocationKey = { readonly userId: string; readonly environmentId: string };
  const readTokens = Effect.fnUntraced(function* (key: AllocationKey) {
    const allocation = yield* allocations.get(key);
    return allocation === null
      ? null
      : { generation: allocation.updatedAt, state: readTokenState(allocation.dnsRecordId) };
  });
  const commitTokens = (key: AllocationKey, generation: string, state: TokenState) =>
    allocations
      .recordDnsIfUnchanged({ ...key, dnsRecordId: encodeTokenState(state), updatedAt: generation })
      .pipe(Effect.map((written) => written !== null));

  // Revokes retired tokens and forgets the revoked ones; failures stay retired for a retry.
  const settleRetired = Effect.fnUntraced(function* (
    connect: RelayConfiguration.CyndrbaseConnectConfiguration,
    key: AllocationKey,
  ) {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const read = yield* readTokens(key);
      if (read === null || read.state.retired.length === 0) return;
      const remaining = (yield* Effect.forEach(read.state.retired, (id) =>
        revokeConnectorToken(connect, id).pipe(
          Effect.as(null),
          Effect.catch((error) =>
            Effect.logWarning("Replaced connector token is still live; will retry revocation", {
              connectorTokenId: id,
              code: error.code,
            }).pipe(Effect.as(id)),
          ),
        ),
      )).filter((id) => id !== null);
      if (remaining.length === read.state.retired.length) return;
      if (yield* commitTokens(key, read.generation, { ...read.state, retired: remaining })) return;
    }
  });

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
      const tokens = readTokenState(allocation.dnsRecordId);
      const connectorTokenIds = [tokens.current, tokens.pending, ...tokens.retired].filter(
        (id) => id !== null,
      );
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
    confirm: Effect.fn("relay.managed_endpoint_provider.confirm")(function* (input) {
      const settings = yield* requireSettings(config, input);
      const key = { userId: input.userId, environmentId: input.environmentId };
      const failed = (cause: unknown) =>
        new ManagedEndpointProvisioningFailed({
          ...key,
          stage: "record-connector-token",
          connectorTokenId: input.connectorTokenId,
          cause,
        });
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        const read = yield* readTokens(key).pipe(Effect.mapError(failed));
        if (read === null) return false;
        const { current, pending, retired } = read.state;
        if (current !== input.connectorTokenId) {
          if (pending !== input.connectorTokenId) return false;
          const next = {
            current: pending,
            pending: null,
            retired: current === null ? retired : [...retired, current],
          };
          if (!(yield* commitTokens(key, read.generation, next).pipe(Effect.mapError(failed)))) {
            continue;
          }
        }
        yield* settleRetired(settings.connect, key).pipe(Effect.ignore);
        return true;
      }
      return yield* failed(new ManagedEndpointTokenStateConflict());
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

      // Provisioning never revokes a token the environment might still use: it only issues
      // and records a pending one. The key names the current token, so repeated or
      // overlapping provisions get the same pending token, and a revoke outage cannot
      // multiply live tokens. Tokens are retired once the environment confirms a newer one.
      yield* settleRetired(settings.connect, key).pipe(
        Effect.mapError(failed("revoke-retired-tokens", { endpointId })),
      );
      let issued: typeof ConnectToken.Type | null = null;
      for (let attempt = 0; issued === null && attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        const read = yield* readTokens(key).pipe(
          Effect.mapError(failed("record-connector-token", { endpointId })),
        );
        const tokens = read?.state ?? readTokenState(null);
        if (tokens.retired.length >= MAX_RETIRED_TOKENS) {
          return yield* failed("revoke-retired-tokens", { endpointId })(
            new ManagedEndpointRetiredTokensOutstanding({ connectorTokenIds: tokens.retired }),
          );
        }
        const token = yield* rpc(
          settings.connect,
          "CreateConnectorToken",
          {
            endpointIds: [endpointId],
            idempotencyKey: `token:${endpointId}:${tokens.current ?? "none"}`,
          },
          ConnectToken,
        ).pipe(Effect.mapError(failed("create-connector-token", { endpointId })));
        const connectorTokenId = token.connectorToken.id;
        if (connectorTokenId === tokens.pending) {
          issued = token;
          break;
        }
        // A different token for the same key means the edge forgot the earlier one.
        const next = {
          current: tokens.current,
          pending: connectorTokenId,
          retired: tokens.pending === null ? tokens.retired : [...tokens.retired, tokens.pending],
        };
        const written =
          read !== null &&
          (yield* commitTokens(key, read.generation, next).pipe(
            Effect.mapError(failed("record-connector-token", { endpointId, connectorTokenId })),
          ));
        if (written) issued = token;
      }
      if (issued === null) {
        return yield* failed("record-connector-token", { endpointId })(
          new ManagedEndpointTokenStateConflict(),
        );
      }
      const connectorTokenId = issued.connectorToken.id;
      // Every provision moves the generation, so an unlink that read the allocation
      // before this relink leaves it in place.
      yield* allocations
        .markReady(key)
        .pipe(Effect.mapError(failed("mark-allocation-ready", { endpointId, connectorTokenId })));
      yield* settleRetired(settings.connect, key).pipe(Effect.ignore);

      return {
        endpoint: managedEndpointForHostname(hostname),
        runtime: {
          environmentId: EnvironmentId.make(input.environmentId),
          providerKind: "pathway_relay",
          connectorToken: issued.token,
          edgeUrl: settings.connect.edgeUrl,
          endpointId,
          connectorTokenId,
        },
      } satisfies ManagedEndpointProvisioningResult;
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);
