import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

const cyndrbaseConnect = {
  apiUrl: "https://connect.example.test",
  edgeUrl: "wss://edge.example.test/connect/v1",
  adminKey: Redacted.make("admin-key"),
};

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: undefined,
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "pathway-relay",
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: "pathway.test",
  managedEndpointNamespace: "dev_julius",
  cyndrbaseConnect,
});

const RpcBody = Schema.Struct({
  hostname: Schema.optional(Schema.String),
  policy: Schema.optional(Schema.Struct({ access: Schema.String })),
  traffic: Schema.optional(Schema.String),
  endpointId: Schema.optional(Schema.String),
  endpointIds: Schema.optional(Schema.Array(Schema.String)),
  endpoint: Schema.optional(Schema.Struct({ id: Schema.String })),
  remove: Schema.optional(Schema.Boolean),
  tokenId: Schema.optional(Schema.String),
  planId: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
});
const decodeRpcBody = Schema.decodeUnknownSync(Schema.fromJsonString(RpcBody));

interface ConnectCall {
  readonly method: string;
  readonly body: typeof RpcBody.Type;
}

/** An in-memory EndpointService with the edge's replay, plan and not-found behavior. */
function makeConnectEdge(options?: { readonly failApplyRevoke?: () => boolean }) {
  const calls: Array<ConnectCall> = [];
  const authorizations = new Set<string>();
  const endpoints = new Map<string, string>();
  const tokens = new Map<string, string>();
  const plans = new Map<string, () => void>();
  const receipts = new Map<string, readonly [number, unknown]>();
  let next = 0;
  const notFound = [404, { code: "not_found" }] as const;
  const plan = (apply: () => void) => {
    const id = `plan-${++next}`;
    plans.set(id, apply);
    return [200, { plan: { id } }] as const;
  };
  const handle = (method: string, body: typeof RpcBody.Type): readonly [number, unknown] => {
    switch (method) {
      case "GetEndpoint": {
        const hostname = endpoints.get(body.endpointId ?? "");
        return hostname ? [200, { endpoint: { id: body.endpointId, hostname } }] : notFound;
      }
      case "CreateEndpoint": {
        if ([...endpoints.values()].includes(body.hostname ?? "")) {
          return [409, { code: "already_exists" }];
        }
        const id = `endpoint-${++next}`;
        endpoints.set(id, body.hostname ?? "");
        return [200, { endpoint: { id, hostname: body.hostname } }];
      }
      case "CreateConnectorToken": {
        const id = `token-${++next}`;
        tokens.set(id, body.endpointIds?.[0] ?? "");
        return [
          200,
          { connectorToken: { id, endpointIds: body.endpointIds }, token: `secret-${id}` },
        ];
      }
      case "PlanRevokeConnectorToken":
        return tokens.has(body.tokenId ?? "")
          ? plan(() => tokens.delete(body.tokenId ?? ""))
          : notFound;
      case "PlanEndpointChange":
        return endpoints.has(body.endpoint?.id ?? "")
          ? plan(() => endpoints.delete(body.endpoint?.id ?? ""))
          : notFound;
      default: {
        const apply = plans.get(body.planId ?? "");
        if (!apply) return notFound;
        plans.delete(body.planId ?? "");
        apply();
        return [200, method === "ApplyEndpointChange" ? { operation: { done: true } } : {}];
      }
    }
  };
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const method = request.url.replace(
        "https://connect.example.test/cyndrbase.connect.v1.EndpointService/",
        "",
      );
      const body = decodeRpcBody(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      );
      calls.push({ method, body });
      authorizations.add(request.headers["authorization"] ?? "");
      // A transient failure leaves no receipt, so the retry runs again.
      if (method === "ApplyRevokeConnectorToken" && options?.failApplyRevoke?.()) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ code: "unavailable" }, { status: 503 }),
        );
      }
      const receiptKey = `${method}:${body.idempotencyKey ?? ""}`;
      const [status, json] =
        (body.idempotencyKey && receipts.get(receiptKey)) || handle(method, body);
      if (body.idempotencyKey) receipts.set(receiptKey, [status, json]);
      return HttpClientResponse.fromWeb(request, Response.json(json, { status }));
    }),
  );
  return { client, calls, authorizations, endpoints, tokens };
}

function makeAllocations(options?: { readonly failRecordDns?: () => boolean }) {
  const allocations = new Map<string, ManagedEndpointAllocations.ManagedEndpointAllocation>();
  const keyOf = (input: { readonly userId: string; readonly environmentId: string }) =>
    `${input.userId}:${input.environmentId}`;
  let generation = 0;
  const mutate = (
    input: { readonly userId: string; readonly environmentId: string },
    change: Partial<ManagedEndpointAllocations.ManagedEndpointAllocation>,
  ) => {
    const allocation = allocations.get(keyOf(input));
    if (allocation !== undefined) {
      allocations.set(keyOf(input), {
        ...allocation,
        ...change,
        updatedAt: `generation-${++generation}`,
      });
    }
  };
  const service = ManagedEndpointAllocations.ManagedEndpointAllocations.of({
    get: (input) => Effect.sync(() => allocations.get(keyOf(input)) ?? null),
    reserve: (input) =>
      Effect.sync(() => {
        const allocation = allocations.get(keyOf(input)) ?? {
          ...input,
          tunnelId: null,
          dnsRecordId: null,
          readyAt: null,
          updatedAt: `generation-${++generation}`,
        };
        allocations.set(keyOf(input), allocation);
        return allocation;
      }),
    recordTunnel: (input) => Effect.sync(() => mutate(input, { tunnelId: input.tunnelId })),
    recordDns: (input) =>
      options?.failRecordDns?.()
        ? Effect.fail(
            new ManagedEndpointAllocations.ManagedEndpointAllocationPersistenceError({
              operation: "record-dns",
              stage: "database-request",
              userId: input.userId,
              environmentId: input.environmentId,
            }),
          )
        : Effect.sync(() => mutate(input, { dnsRecordId: input.dnsRecordId })),
    markReady: (input) => Effect.sync(() => mutate(input, { readyAt: "2026-06-02T00:00:00.000Z" })),
    claimDeprovision: (input) =>
      Effect.sync(() => {
        if (allocations.get(keyOf(input))?.updatedAt !== input.updatedAt) return null;
        mutate(input, {});
        return allocations.get(keyOf(input))?.updatedAt ?? null;
      }),
    remove: (input) => Effect.sync(() => void allocations.delete(keyOf(input))),
    removeClaimed: (input) =>
      Effect.sync(() => {
        if (allocations.get(keyOf(input))?.updatedAt !== input.updatedAt) return false;
        return allocations.delete(keyOf(input));
      }),
  });
  return { service, allocations };
}

function providerLayer(
  edge = makeConnectEdge(),
  allocations = makeAllocations().service,
  settings = config,
) {
  return ManagedEndpointProvider.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(RelayConfiguration.layer(settings)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, edge.client)),
    Layer.provide(
      Layer.succeed(ManagedEndpointAllocations.ManagedEndpointAllocations, allocations),
    ),
  );
}

function expectedManagedHostname(environmentId: string, userId = "user_ABC"): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(`dev_julius:${userId}:${environmentId}`)
    .digest("hex")
    .slice(0, 16);
  return `dev-julius-${hash}.pathway.test`;
}

const key = { userId: "user_ABC", environmentId: "env_ABC" } as const;
const request = key;
const tokenIdOf = (connectorToken: string) => connectorToken.replace("secret-", "");

describe("ManagedEndpointProvider", () => {
  it.effect("provisions a public Connect endpoint and an endpoint-scoped connector token", () => {
    const edge = makeConnectEdge();
    const allocations = makeAllocations();
    const hostname = expectedManagedHostname("env_ABC");

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* provider.provision(request);

      expect(result).toEqual({
        endpoint: {
          httpBaseUrl: `https://${hostname}/`,
          wsBaseUrl: `wss://${hostname}/ws`,
          providerKind: "cloudflare_tunnel",
        },
        runtime: {
          environmentId: "env_ABC",
          providerKind: "pathway_relay",
          connectorToken: "secret-token-2",
          edgeUrl: "wss://edge.example.test/connect/v1",
          endpointId: "endpoint-1",
        },
      });
      expect(edge.calls.map((call) => call.method)).toEqual([
        "CreateEndpoint",
        "CreateConnectorToken",
      ]);
      expect(edge.calls[0]?.body).toMatchObject({
        hostname,
        policy: { access: "ACCESS_KIND_PUBLIC" },
        traffic: "TRAFFIC_KIND_HTTP",
      });
      expect(edge.calls[1]?.body.endpointIds).toEqual(["endpoint-1"]);
      expect([...edge.authorizations]).toEqual(["Bearer admin-key"]);
      expect(allocations.allocations.get("user_ABC:env_ABC")).toMatchObject({
        hostname,
        tunnelId: "endpoint-1",
        dnsRecordId: "token-2",
        readyAt: expect.any(String),
      });
    }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
  });

  it.effect("keeps the endpoint and rotates the connector token on every provision", () => {
    const edge = makeConnectEdge();

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const first = yield* provider.provision(request);
      const second = yield* provider.provision(request);

      expect(second.runtime.endpointId).toBe(first.runtime.endpointId);
      expect(second.runtime.connectorToken).not.toBe(first.runtime.connectorToken);
      expect(edge.calls.slice(2).map((call) => call.method)).toEqual([
        "GetEndpoint",
        "CreateConnectorToken",
        "PlanRevokeConnectorToken",
        "ApplyRevokeConnectorToken",
      ]);
      expect([...edge.tokens.keys()]).toEqual(["token-3"]);
    }).pipe(Effect.provide(providerLayer(edge)));
  });

  it.effect("recreates an endpoint the edge no longer knows", () => {
    const edge = makeConnectEdge();

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision(request);
      // An edge restart loses its in-memory records.
      edge.endpoints.clear();
      edge.tokens.clear();
      const result = yield* provider.provision(request);

      expect(result.runtime.endpointId).toBe("endpoint-3");
      expect([...edge.endpoints.values()]).toEqual([expectedManagedHostname("env_ABC")]);
    }).pipe(Effect.provide(providerLayer(edge)));
  });

  it.effect("a retried provision reuses its token instead of leaving an untracked one", () => {
    const edge = makeConnectEdge();
    let failures = 1;
    const allocations = makeAllocations({ failRecordDns: () => failures-- > 0 });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(provider.provision(request));
      expect(error).toMatchObject({
        _tag: "ManagedEndpointProvisioningFailed",
        stage: "record-connector-token",
      });
      const retried = yield* provider.provision(request);

      expect(retried.runtime.connectorToken).toBe("secret-token-2");
      expect([...edge.tokens.keys()]).toEqual(["token-2"]);
      expect(allocations.allocations.get("user_ABC:env_ABC")?.dnsRecordId).toBe("token-2");
    }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
  });

  it.effect("a failed token record keeps the old token live and tracked", () => {
    const edge = makeConnectEdge();
    let failures = 0;
    const allocations = makeAllocations({ failRecordDns: () => failures-- > 0 });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const first = yield* provider.provision(request);
      failures = 1;
      const error = yield* Effect.flip(provider.provision(request));
      expect(error).toMatchObject({ stage: "record-connector-token" });
      const oldTokenId = tokenIdOf(first.runtime.connectorToken);
      expect(allocations.allocations.get("user_ABC:env_ABC")?.dnsRecordId).toBe(oldTokenId);
      expect(edge.tokens.has(oldTokenId)).toBe(true);

      // The retry reuses the token the failed attempt issued, then revokes the old one.
      const retried = yield* provider.provision(request);
      const newTokenId = tokenIdOf(retried.runtime.connectorToken);
      expect(edge.calls.filter((call) => call.method === "CreateConnectorToken")).toHaveLength(3);
      expect([...edge.tokens.keys()]).toEqual([newTokenId]);
      expect(allocations.allocations.get("user_ABC:env_ABC")?.dnsRecordId).toBe(newTokenId);
    }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
  });

  it.effect("a failed revocation still returns the new token and retries later", () => {
    let failures = 0;
    const edge = makeConnectEdge({ failApplyRevoke: () => failures-- > 0 });
    const allocations = makeAllocations();

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const first = yield* provider.provision(request);
      failures = 1;
      const second = yield* provider.provision(request);
      const oldTokenId = tokenIdOf(first.runtime.connectorToken);
      const newTokenId = tokenIdOf(second.runtime.connectorToken);
      expect(edge.tokens.has(oldTokenId)).toBe(true);
      expect(allocations.allocations.get("user_ABC:env_ABC")?.dnsRecordId).toBe(
        `${newTokenId} ${oldTokenId}`,
      );

      const third = yield* provider.provision(request);
      const currentTokenId = tokenIdOf(third.runtime.connectorToken);
      expect([...edge.tokens.keys()]).toEqual([currentTokenId]);
      expect(allocations.allocations.get("user_ABC:env_ABC")?.dnsRecordId).toBe(currentTokenId);
    }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
  });

  it.effect("fails closed when Cyndrbase Connect is not configured", () =>
    Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(provider.provision(request));

      expect(error).toMatchObject({
        _tag: "ManagedEndpointProvisioningNotConfigured",
        missingSettings: ["cyndrbaseConnect"],
      });
    }).pipe(
      Effect.provide(
        providerLayer(makeConnectEdge(), makeAllocations().service, {
          ...config,
          cyndrbaseConnect: undefined,
        }),
      ),
    ),
  );

  it.effect("deprovision revokes the token, removes the endpoint, and frees the allocation", () => {
    const edge = makeConnectEdge();
    const allocations = makeAllocations();

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision(request);
      yield* provider.deprovision(key);

      expect(edge.calls.slice(2).map((call) => call.method)).toEqual([
        "PlanRevokeConnectorToken",
        "ApplyRevokeConnectorToken",
        "PlanEndpointChange",
        "ApplyEndpointChange",
      ]);
      expect(edge.endpoints.size + edge.tokens.size).toBe(0);
      expect(allocations.allocations.size).toBe(0);

      // A relink then gets a fresh endpoint under the same hostname.
      const relinked = yield* provider.provision(request);
      expect(relinked.endpoint.httpBaseUrl).toBe(`https://${expectedManagedHostname("env_ABC")}/`);
      expect(relinked.runtime.endpointId).not.toBe("endpoint-1");
    }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
  });

  it.effect("does not deprovision an allocation superseded by a concurrent relink", () => {
    const edge = makeConnectEdge();

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision(request);
      const unlinkTarget = yield* provider.prepareDeprovision(key);
      yield* provider.provision(request);
      const callCount = edge.calls.length;

      yield* provider.deprovision({ ...key, target: unlinkTarget });

      expect(edge.calls).toHaveLength(callCount);
      expect(edge.endpoints.size).toBe(1);
    }).pipe(Effect.provide(providerLayer(edge)));
  });

  it.effect("scopes hostnames by user", () => {
    const edge = makeConnectEdge();

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({ userId: "user_ABC", environmentId: "env_shared" });
      yield* provider.provision({ userId: "user_DEF", environmentId: "env_shared" });

      expect([...edge.endpoints.values()]).toEqual([
        expectedManagedHostname("env_shared", "user_ABC"),
        expectedManagedHostname("env_shared", "user_DEF"),
      ]);
    }).pipe(Effect.provide(providerLayer(edge)));
  });
});
