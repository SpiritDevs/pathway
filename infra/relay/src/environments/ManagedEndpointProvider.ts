import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
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
  "finish-unlink",
  "ensure-endpoint",
  "record-endpoint",
  "claim-connector-token",
  "revoke-stray-tokens",
  "create-connector-token",
  "store-connector-token",
  "open-connector-token",
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
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

const ManagedEndpointDeprovisioningStage = Schema.Literals([
  "load-allocation",
  "claim-teardown",
  "revoke-connector-tokens",
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
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed endpoint deprovisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

/** Another provision holds the connector token slot; a retry returns the token it stores. */
export class ManagedEndpointTokenSlotBusy extends Schema.TaggedErrorClass<ManagedEndpointTokenSlotBusy>()(
  "ManagedEndpointTokenSlotBusy",
  {},
) {}

/** An unlink claimed the allocation while this provision ran. */
export class ManagedEndpointUnlinked extends Schema.TaggedErrorClass<ManagedEndpointUnlinked>()(
  "ManagedEndpointUnlinked",
  {},
) {}

export type ManagedEndpointProviderError =
  | ManagedEndpointProvisioningNotConfigured
  | ManagedEndpointProvisioningFailed
  | ManagedTunnelLimits.ManagedTunnelLimitExceeded;

export interface ManagedEndpointProvisioningResult {
  readonly endpoint: RelayManagedEndpoint;
  readonly runtime: RelayManagedEndpointRuntimeConfig;
}

export class ManagedEndpointProvider extends Context.Service<
  ManagedEndpointProvider,
  {
    /** Returns the endpoint and its one connector token, minting the token only once. */
    readonly provision: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
    /**
     * Revokes the endpoint's tokens, removes the endpoint, then deletes the allocation. Once
     * claimed, nothing stops the teardown; a retry, or the next provision, finishes it.
     */
    readonly deprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
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
const ConnectTokenPage = Schema.Struct({
  connectorTokens: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        endpointIds: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
  page: Schema.optional(Schema.Struct({ nextPageToken: Schema.optional(Schema.String) })),
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

// The allocation's dnsRecordId column, named for cloudflared, is the endpoint's connector token
// slot, written only by compare-and-set on its value. A provision marks it Minting before it
// sweeps and mints, and stores a token only over its own mark, so a sweep never revokes a token
// that can still be stored. Unlink marks it TearingDown for good. Anything that does not decode,
// such as a cloudflared DNS record ID, is an empty slot.
const TokenSlot = Schema.Union([
  Schema.TaggedStruct("Minting", { attempt: Schema.String }),
  Schema.TaggedStruct("Stored", {
    endpointId: Schema.String,
    connectorTokenId: Schema.String,
    sealedToken: Schema.String,
  }),
  Schema.TaggedStruct("TearingDown", {}),
]);
type TokenSlot = typeof TokenSlot.Type;
const decodeTokenSlotJson = Schema.decodeUnknownOption(Schema.fromJsonString(TokenSlot));
const decodeTokenSlot = (value: string | null): TokenSlot | undefined =>
  value === null ? undefined : Option.getOrUndefined(decodeTokenSlotJson(value));
const encodeTokenSlot = Schema.encodeSync(Schema.fromJsonString(TokenSlot));
const TEARING_DOWN = encodeTokenSlot({ _tag: "TearingDown" });
const MAX_TEARDOWN_CLAIMS = 5;

type AllocationKey = { readonly userId: string; readonly environmentId: string };

// Tokens are sealed with AES-GCM and bound to the allocation and endpoint they were minted for.
const tokenCipher = (connect: RelayConfiguration.CyndrbaseConnectConfiguration, usage: KeyUsage) =>
  Effect.tryPromise(() => {
    const raw = Result.getOrUndefined(Encoding.decodeBase64Url(Redacted.value(connect.tokenKey)));
    if (raw?.length !== 32) {
      throw new Error("CYNDRBASE_CONNECT_TOKEN_KEY must encode 32 random bytes");
    }
    return globalThis.crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, [
      usage,
    ]);
  });
const tokenAad = (key: AllocationKey, endpointId: string, connectorTokenId: string) =>
  new TextEncoder().encode(
    JSON.stringify([
      "connector-token/v1",
      key.userId,
      key.environmentId,
      endpointId,
      connectorTokenId,
    ]),
  );
const sealToken = (
  connect: RelayConfiguration.CyndrbaseConnectConfiguration,
  additionalData: Uint8Array<ArrayBuffer>,
  token: string,
) =>
  Effect.flatMap(tokenCipher(connect, "encrypt"), (cipher) =>
    Effect.tryPromise(async () => {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const sealed = await globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData },
        cipher,
        new TextEncoder().encode(token),
      );
      return Encoding.encodeBase64Url(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
    }),
  );
const openToken = (
  connect: RelayConfiguration.CyndrbaseConnectConfiguration,
  additionalData: Uint8Array<ArrayBuffer>,
  sealedToken: string,
) =>
  Effect.flatMap(tokenCipher(connect, "decrypt"), (cipher) =>
    Effect.tryPromise(async () => {
      const bytes = Result.getOrThrow(Encoding.decodeBase64Url(sealedToken));
      const clear = await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData },
        cipher,
        bytes.slice(12),
      );
      return new TextDecoder().decode(clear);
    }),
  );

const isNotFound = (error: CyndrbaseConnectRpcError) => error.code === "not_found";
const isConnectRpcError = Schema.is(CyndrbaseConnectRpcError);
const isUnlinked = Schema.is(ManagedEndpointUnlinked);

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

  // The relay mints every token for its endpoints, so the edge's list is the full set.
  const endpointTokenIds = Effect.fnUntraced(function* (
    connect: RelayConfiguration.CyndrbaseConnectConfiguration,
    endpointId: string,
  ) {
    const ids: Array<string> = [];
    let pageToken = "";
    do {
      const { connectorTokens = [], page } = yield* rpc(
        connect,
        "ListConnectorTokens",
        { page: { pageToken } },
        ConnectTokenPage,
      );
      for (const token of connectorTokens) {
        if (token.endpointIds?.includes(endpointId)) ids.push(token.id);
      }
      pageToken = page?.nextPageToken ?? "";
    } while (pageToken !== "");
    return ids;
  });

  const revokeEndpointTokens = (
    connect: RelayConfiguration.CyndrbaseConnectConfiguration,
    endpointId: string,
  ) =>
    endpointTokenIds(connect, endpointId).pipe(
      Effect.flatMap((ids) =>
        Effect.forEach(ids, (id) => revokeConnectorToken(connect, id), { discard: true }),
      ),
    );

  const teardown = Effect.fnUntraced(function* (key: AllocationKey) {
    const failed =
      (stage: typeof ManagedEndpointDeprovisioningStage.Type, endpointId?: string | null) =>
      (cause: unknown) =>
        new ManagedEndpointDeprovisioningFailed({
          ...key,
          stage,
          ...(endpointId ? { endpointId } : {}),
          cause,
        });
    const read = yield* allocations.get(key).pipe(Effect.mapError(failed("load-allocation")));
    if (read === null) return;
    // Once the slot says TearingDown, no provision can store a token or take it back.
    let held = read.dnsRecordId;
    for (let claims = 0; held !== TEARING_DOWN; claims++) {
      if (claims === MAX_TEARDOWN_CLAIMS) {
        return yield* failed("claim-teardown")(new ManagedEndpointTokenSlotBusy());
      }
      const swapped = yield* allocations
        .swapTokenSlot({ ...key, expected: held, next: TEARING_DOWN })
        .pipe(Effect.mapError(failed("claim-teardown")));
      // Gone, or replaced by a fresh allocation that a relink owns.
      if (swapped === null) return;
      held = swapped;
    }
    const allocation = yield* allocations.get(key).pipe(Effect.mapError(failed("load-allocation")));
    if (allocation === null) return;
    const endpointId = allocation.tunnelId;
    // Without Connect settings this relay cannot have issued anything to clean up.
    const connect = config.cyndrbaseConnect;
    if (connect && endpointId !== null) {
      yield* revokeEndpointTokens(connect, endpointId).pipe(
        Effect.mapError(failed("revoke-connector-tokens", endpointId)),
      );
      yield* removeEndpoint(connect, endpointId).pipe(
        Effect.mapError(failed("remove-endpoint", endpointId)),
      );
    }
    yield* allocations
      .removeWithTokenSlot({ ...key, tokenSlot: TEARING_DOWN })
      .pipe(Effect.mapError(failed("remove-allocation", endpointId)));
  });

  // Returns the endpoint's stored token, minting and storing one if the slot holds none.
  const connectorToken = Effect.fnUntraced(function* (
    connect: RelayConfiguration.CyndrbaseConnectConfiguration,
    key: AllocationKey,
    read: string | null,
    endpointId: string,
  ) {
    const failed = (stage: typeof ManagedEndpointProvisioningStage.Type) => (cause: unknown) =>
      new ManagedEndpointProvisioningFailed({ ...key, stage, endpointId, cause });
    // What a provision does with a slot it does not hold.
    const settle = (held: string | null, stage: typeof ManagedEndpointProvisioningStage.Type) => {
      const slot = decodeTokenSlot(held);
      if (slot?._tag === "Stored" && slot.endpointId === endpointId) {
        return openToken(
          connect,
          tokenAad(key, endpointId, slot.connectorTokenId),
          slot.sealedToken,
        ).pipe(Effect.mapError(failed("open-connector-token")));
      }
      return Effect.fail(
        failed(stage)(
          held === null || slot?._tag === "TearingDown"
            ? new ManagedEndpointUnlinked()
            : new ManagedEndpointTokenSlotBusy(),
        ),
      );
    };
    const slot = decodeTokenSlot(read);
    if (
      slot?._tag === "TearingDown" ||
      (slot?._tag === "Stored" && slot.endpointId === endpointId)
    ) {
      return yield* settle(read, "claim-connector-token");
    }

    // Empty, a token for an endpoint the edge lost, or an attempt that never finished.
    const attempt = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(failed("claim-connector-token")),
    );
    const mark = encodeTokenSlot({ _tag: "Minting", attempt });
    const marked = yield* allocations
      .swapTokenSlot({ ...key, expected: read, next: mark })
      .pipe(Effect.mapError(failed("claim-connector-token")));
    if (marked !== mark) return yield* settle(marked, "claim-connector-token");
    // A token listed while this attempt still holds the slot was minted under an older mark,
    // so it can never be stored. Revoking those first leaves at most one unstored token live.
    const strays = yield* endpointTokenIds(connect, endpointId).pipe(
      Effect.mapError(failed("revoke-stray-tokens")),
    );
    const holder = yield* allocations
      .get(key)
      .pipe(Effect.mapError(failed("claim-connector-token")));
    const held = holder?.dnsRecordId ?? null;
    if (held !== mark) return yield* settle(held, "claim-connector-token");
    yield* Effect.forEach(strays, (id) => revokeConnectorToken(connect, id), {
      discard: true,
    }).pipe(Effect.mapError(failed("revoke-stray-tokens")));

    const minted = yield* rpc(
      connect,
      "CreateConnectorToken",
      { endpointIds: [endpointId], idempotencyKey: `connector-token:${attempt}` },
      ConnectToken,
    ).pipe(Effect.mapError(failed("create-connector-token")));
    const connectorTokenId = minted.connectorToken.id;
    const stored = encodeTokenSlot({
      _tag: "Stored",
      endpointId,
      connectorTokenId,
      sealedToken: yield* sealToken(
        connect,
        tokenAad(key, endpointId, connectorTokenId),
        minted.token,
      ).pipe(Effect.mapError(failed("store-connector-token"))),
    });
    const kept = yield* allocations
      .swapTokenSlot({ ...key, expected: mark, next: stored })
      .pipe(Effect.mapError(failed("store-connector-token")));
    if (kept === stored) return minted.token;
    // Another provision or an unlink took the slot, so this token can never be stored.
    yield* revokeConnectorToken(connect, connectorTokenId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Unstored connector token stays live until unlink", {
          connectorTokenId,
          code: error.code,
        }),
      ),
    );
    return yield* settle(kept, "store-connector-token");
  });

  return ManagedEndpointProvider.of({
    deprovision: Effect.fn("relay.managed_endpoint_provider.deprovision")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.user_id": input.userId,
        "relay.environment_id": input.environmentId,
      });
      yield* teardown({ userId: input.userId, environmentId: input.environmentId });
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
      const reserve = allocations
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
      let allocation = yield* reserve;
      // An unlink that stopped partway still holds the allocation: finish it and start over.
      if (allocation.dnsRecordId === TEARING_DOWN) {
        yield* teardown(key).pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                ...key,
                stage: "finish-unlink",
                hostname: requestedHostname,
                cause,
              }),
          ),
        );
        allocation = yield* reserve;
      }
      const { hostname } = allocation;
      const failed =
        (stage: typeof ManagedEndpointProvisioningStage.Type, endpointId?: string) =>
        (cause: unknown) =>
          new ManagedEndpointProvisioningFailed({
            ...key,
            stage,
            hostname,
            ...(endpointId === undefined ? {} : { endpointId }),
            cause,
          });

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
              Effect.mapError(failed("ensure-endpoint", allocation.tunnelId)),
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
          .pipe(Effect.mapError(failed("record-endpoint", endpointId)));
      }

      const token = yield* connectorToken(
        settings.connect,
        key,
        allocation.dnsRecordId,
        endpointId,
      ).pipe(
        // An unlink may not have seen the endpoint this provision just made.
        Effect.tapError((error) =>
          recorded === null && isUnlinked(error.cause)
            ? removeEndpoint(settings.connect, endpointId).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      yield* allocations
        .markReady(key)
        .pipe(Effect.mapError(failed("mark-allocation-ready", endpointId)));

      return {
        endpoint: managedEndpointForHostname(hostname),
        runtime: {
          environmentId: EnvironmentId.make(input.environmentId),
          providerKind: "pathway_relay",
          connectorToken: token,
          edgeUrl: settings.connect.edgeUrl,
          endpointId,
        },
      } satisfies ManagedEndpointProvisioningResult;
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);
