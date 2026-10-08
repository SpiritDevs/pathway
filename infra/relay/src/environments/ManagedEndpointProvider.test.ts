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
  tokenKey: Redacted.make(Buffer.alloc(32, 7).toString("base64url")),
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
  page: Schema.optional(Schema.Struct({ pageToken: Schema.optional(Schema.String) })),
  idempotencyKey: Schema.optional(Schema.String),
});
const decodeRpcBody = Schema.decodeUnknownSync(Schema.fromJsonString(RpcBody));

interface ConnectCall {
  readonly method: string;
  readonly body: typeof RpcBody.Type;
}

/** An in-memory EndpointService with the edge's replay, paging, plan and not-found behavior. */
function makeConnectEdge(options?: {
  /** Runs before a call reaches the edge, as when the network delays it. */
  readonly beforeCall?: (method: string) => Effect.Effect<void>;
  /** Runs after the edge applied a call, before the relay sees its response. */
  readonly afterCall?: (method: string) => Effect.Effect<void>;
  /** Mints a token but loses the response, as when the network drops it. */
  readonly loseMintResponse?: () => boolean;
  readonly failApplyEndpointChange?: () => boolean;
}) {
  const calls: Array<ConnectCall> = [];
  const authorizations = new Set<string>();
  const endpoints = new Map<string, string>();
  // Token ID to the endpoint it serves; each token's secret is `secret-<id>`.
  const tokens = new Map<string, string>();
  const plans = new Map<string, () => void>();
  const receipts = new Map<string, readonly [number, unknown]>();
  let next = 0;
  const notFound = [404, { code: "not_found" }] as const;
  const unavailable = [503, { code: "unavailable" }] as const;
  const paged = (
    body: typeof RpcBody.Type,
    field: string,
    records: Map<string, string>,
    item: (id: string, value: string) => unknown,
  ) => {
    const start = Number(body.page?.pageToken || 0);
    const more = start + 2 < records.size;
    return {
      [field]: [...records].slice(start, start + 2).map(([id, value]) => item(id, value)),
      page: more ? { nextPageToken: String(start + 2) } : {},
    };
  };
  // An apply returns a response only when it fails, as when its plan went stale.
  const plan = (apply: () => readonly [number, unknown] | void) => {
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
      // Two per page, so callers must follow the page token.
      case "ListConnectorTokens":
        return [
          200,
          paged(body, "connectorTokens", tokens, (id, endpointId) => ({
            id,
            endpointIds: [endpointId],
          })),
        ];
      case "ListEndpoints":
        return [200, paged(body, "endpoints", endpoints, (id, hostname) => ({ id, hostname }))];
      case "PlanRevokeConnectorToken":
        return tokens.has(body.tokenId ?? "")
          ? plan(() => void tokens.delete(body.tokenId ?? ""))
          : notFound;
      // Like the edge, removal revokes the tokens its plan named, and is stale if they changed.
      case "PlanEndpointChange": {
        const id = body.endpoint?.id ?? "";
        const scoped = () => [...tokens].filter(([, endpointId]) => endpointId === id);
        const planned = scoped();
        return endpoints.has(id)
          ? plan(() => {
              if (scoped().length !== planned.length) return [400, { code: "failed_precondition" }];
              endpoints.delete(id);
              for (const [token] of planned) tokens.delete(token);
            })
          : notFound;
      }
      default: {
        const apply = plans.get(body.planId ?? "");
        if (!apply) return notFound;
        plans.delete(body.planId ?? "");
        return (
          apply() ?? [200, method === "ApplyEndpointChange" ? { operation: { done: true } } : {}]
        );
      }
    }
  };
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const method = request.url.replace(
        "https://connect.example.test/cyndrbase.connect.v1.EndpointService/",
        "",
      );
      const body = decodeRpcBody(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      );
      if (options?.beforeCall) yield* options.beforeCall(method);
      calls.push({ method, body });
      authorizations.add(request.headers["authorization"] ?? "");
      const respond = ([status, json]: readonly [number, unknown]) =>
        HttpClientResponse.fromWeb(request, Response.json(json, { status }));
      // A transient failure leaves no receipt, so the retry runs again.
      if (method === "ApplyEndpointChange" && options?.failApplyEndpointChange?.()) {
        return respond(unavailable);
      }
      const receiptKey = `${method}:${body.idempotencyKey ?? ""}`;
      const result = (body.idempotencyKey && receipts.get(receiptKey)) || handle(method, body);
      if (body.idempotencyKey) receipts.set(receiptKey, result);
      if (options?.afterCall) yield* options.afterCall(method);
      if (method === "CreateConnectorToken" && options?.loseMintResponse?.()) {
        return respond(unavailable);
      }
      return respond(result);
    }),
  );
  return { client, calls, authorizations, endpoints, tokens, receipts };
}

const secrets = (edge: ReturnType<typeof makeConnectEdge>) =>
  [...edge.tokens.keys()].map((id) => `secret-${id}`);

function makeAllocations(options?: {
  readonly afterReserve?: () => Effect.Effect<void>;
  readonly afterSwap?: (next: string) => Effect.Effect<void>;
}) {
  const allocations = new Map<string, ManagedEndpointAllocations.ManagedEndpointAllocation>();
  const keyOf = (input: { readonly userId: string; readonly environmentId: string }) =>
    `${input.userId}:${input.environmentId}`;
  let generation = 0;
  // Like the Convex mutations, writes apply only to the allocation the caller names.
  const named = (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly allocationId: string;
  }) => {
    const allocation = allocations.get(keyOf(input));
    return allocation?.allocationId === input.allocationId ? allocation : undefined;
  };
  const mutate = (
    input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly allocationId: string;
    },
    change: Partial<ManagedEndpointAllocations.ManagedEndpointAllocation>,
  ) => {
    const allocation = named(input);
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
      Effect.gen(function* () {
        const allocation = allocations.get(keyOf(input)) ?? {
          ...input,
          allocationId: `allocation-${++generation}`,
          tunnelId: null,
          dnsRecordId: null,
          readyAt: null,
          updatedAt: `generation-${generation}`,
        };
        allocations.set(keyOf(input), allocation);
        if (options?.afterReserve) yield* options.afterReserve();
        return allocation;
      }),
    recordTunnel: (input) =>
      Effect.sync(() => {
        const kept = named(input) !== undefined;
        mutate(input, { tunnelId: input.tunnelId });
        return kept;
      }),
    swapTokenSlot: (input) =>
      Effect.gen(function* () {
        const allocation = named(input);
        if (allocation === undefined) return null;
        if (allocation.dnsRecordId !== input.expected) return allocation.dnsRecordId;
        mutate(input, { dnsRecordId: input.next });
        if (options?.afterSwap) yield* options.afterSwap(input.next);
        return input.next;
      }),
    markReady: (input) => Effect.sync(() => mutate(input, { readyAt: "2026-06-02T00:00:00.000Z" })),
    remove: (input) =>
      Effect.sync(() => named(input) !== undefined && allocations.delete(keyOf(input))),
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
type Provider = ManagedEndpointProvider.ManagedEndpointProvider["Service"];

describe("ManagedEndpointProvider", () => {
  it.effect(
    "provisions a public Connect endpoint and stores its one connector token sealed",
    () => {
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
          "ListConnectorTokens",
        ]);
        expect(edge.calls[0]?.body).toMatchObject({
          hostname,
          policy: { access: "ACCESS_KIND_PUBLIC" },
          traffic: "TRAFFIC_KIND_HTTP",
        });
        expect(edge.calls[1]?.body).toMatchObject({
          endpointIds: ["endpoint-1"],
          idempotencyKey: "connector-token:allocation-1:endpoint-1",
        });
        expect([...edge.authorizations]).toEqual(["Bearer admin-key"]);
        const allocation = allocations.allocations.get("user_ABC:env_ABC");
        expect(allocation).toMatchObject({
          hostname,
          tunnelId: "endpoint-1",
          readyAt: expect.any(String),
        });
        expect(allocation?.dnsRecordId).not.toContain("secret-token-2");
      }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
    },
  );

  it.effect("returns the same token on every later provision, without listing tokens", () => {
    const edge = makeConnectEdge();

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const first = yield* provider.provision(request);
      const firstCalls = edge.calls.length;
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(yield* provider.provision(request)).toEqual(first);
      }
      expect(edge.calls.slice(firstCalls).map((call) => call.method)).toEqual(
        Array(3).fill("GetEndpoint"),
      );
    }).pipe(Effect.provide(providerLayer(edge)));
  });

  it.effect("racing first provisions agree on one live token, wherever the second lands", () =>
    Effect.gen(function* () {
      for (const point of ["CreateEndpoint", "ListConnectorTokens", "CreateConnectorToken"]) {
        let provider!: Provider;
        let second: ManagedEndpointProvider.ManagedEndpointProvisioningResult | undefined;
        let armed = true;
        const edge = makeConnectEdge({
          afterCall: (method) => {
            if (!armed || method !== point) return Effect.void;
            armed = false;
            return provider.provision(request).pipe(
              Effect.tap((result) => Effect.sync(() => (second = result))),
              Effect.orDie,
              Effect.asVoid,
            );
          },
        });
        const first = yield* Effect.gen(function* () {
          provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
          return yield* provider.provision(request);
        }).pipe(Effect.provide(providerLayer(edge)));

        expect(second?.runtime.connectorToken).toBe(first.runtime.connectorToken);
        expect(secrets(edge)).toEqual([first.runtime.connectorToken]);
      }
    }),
  );

  it.effect("mints that reach the edge after the token was stored get that token back", () => {
    let provider!: Provider;
    // Seven attempts' mints are held up in the network while an eighth stores its token; then
    // each lands, and its response is lost.
    let delayed = 7;
    let handled = 0;
    const edge = makeConnectEdge({
      beforeCall: (method) => {
        if (method !== "CreateConnectorToken" || delayed === 0) return Effect.void;
        delayed--;
        return Effect.exit(provider.provision(request)).pipe(Effect.asVoid);
      },
      loseMintResponse: () => ++handled > 1,
    });

    return Effect.gen(function* () {
      provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      expect(yield* Effect.flip(provider.provision(request))).toMatchObject({
        stage: "create-connector-token",
      });
      expect(handled).toBe(8);
      expect(edge.tokens.size).toBe(1);
      const { runtime } = yield* provider.provision(request);
      expect(secrets(edge)).toEqual([runtime.connectorToken]);
    }).pipe(Effect.provide(providerLayer(edge)));
  });

  it.effect("a lost mint is replayed, and one minted after the edge forgets it is swept", () => {
    let lose = true;
    const edge = makeConnectEdge({ loseMintResponse: () => lose });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(yield* Effect.flip(provider.provision(request))).toMatchObject({
          stage: "create-connector-token",
        });
        expect(edge.tokens.size).toBe(1);
      }
      lose = false;
      // Past the edge's receipt retention the same key mints a new token.
      edge.receipts.clear();
      const { runtime } = yield* provider.provision(request);
      expect(secrets(edge)).toEqual([runtime.connectorToken]);
    }).pipe(Effect.provide(providerLayer(edge)));
  });

  it.effect("provisions over an allocation that cloudflared left behind", () => {
    const edge = makeConnectEdge();
    const allocations = makeAllocations();
    allocations.allocations.set("user_ABC:env_ABC", {
      ...key,
      allocationId: "allocation-legacy",
      hostname: expectedManagedHostname("env_ABC"),
      tunnelName: "dev-julius-tunnel",
      tunnelId: "c1a3a8b2-5d2e-4f6a-9d5b-0e2f7b8c9d10",
      dnsRecordId: "023e105f4ecef8ad9ca31a8372d0c353",
      readyAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const { runtime } = yield* provider.provision(request);

      expect(runtime.endpointId).toBe("endpoint-1");
      expect(secrets(edge)).toEqual([runtime.connectorToken]);
      expect((yield* provider.provision(request)).runtime).toEqual(runtime);
    }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
  });

  it.effect("recreates an endpoint the edge no longer knows", () => {
    const edge = makeConnectEdge();

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision(request);
      // An edge restart loses its in-memory records.
      edge.endpoints.clear();
      edge.tokens.clear();
      edge.receipts.clear();
      const result = yield* provider.provision(request);

      expect(result.runtime.endpointId).not.toBe("endpoint-1");
      expect([...edge.endpoints.values()]).toEqual([expectedManagedHostname("env_ABC")]);
      expect(secrets(edge)).toEqual([result.runtime.connectorToken]);
    }).pipe(Effect.provide(providerLayer(edge)));
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

      expect(edge.calls.slice(3).map((call) => call.method)).toEqual([
        "ListConnectorTokens",
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

  it.effect(
    "an unlink racing a provision leaves no credential and nothing a relink can't reuse",
    () =>
      Effect.gen(function* () {
        const races = [
          { linked: false, point: "CreateEndpoint" },
          { linked: false, point: "ListConnectorTokens" },
          { linked: false, point: "CreateConnectorToken" },
          { linked: true, point: "GetEndpoint" },
        ];
        for (const { linked, point } of races) {
          let provider!: Provider;
          let armed = false;
          const edge = makeConnectEdge({
            afterCall: (method) => {
              if (!armed || method !== point) return Effect.void;
              armed = false;
              return provider.deprovision(key).pipe(Effect.orDie);
            },
          });
          const allocations = makeAllocations();
          yield* Effect.gen(function* () {
            provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
            if (linked) yield* provider.provision(request);
            armed = true;
            yield* Effect.exit(provider.provision(request));

            // No credential survives; an endpoint left behind is the next relink's to adopt.
            expect({ point, tokens: edge.tokens.size }).toEqual({ point, tokens: 0 });
            expect(allocations.allocations.size).toBe(0);
            yield* provider.provision(request);
            yield* provider.deprovision(key);
            expect(edge.endpoints.size + edge.tokens.size).toBe(0);
          }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
        }
      }),
  );

  it.effect("a stale unlink never touches the allocation a relink created", () =>
    Effect.gen(function* () {
      // Unlink A pauses after its claim or partway through revoking. Meanwhile a retry finishes
      // the unlink, a relink provisions anew, and another unlink claims that allocation.
      for (const pause of ["after-claim", "while-revoking"] as const) {
        let provider!: Provider;
        let armed = false;
        const allocations = makeAllocations({
          afterSwap: (next) =>
            pause === "after-claim" && next.includes("TearingDown") ? meanwhile : Effect.void,
        });
        const edge = makeConnectEdge({
          afterCall: (method) =>
            pause === "while-revoking" && method === "ListConnectorTokens"
              ? meanwhile
              : Effect.void,
        });
        let relinked!: ManagedEndpointProvider.ManagedEndpointProvisioningResult;
        const meanwhile = Effect.suspend(() => {
          if (!armed) return Effect.void;
          armed = false;
          return Effect.gen(function* () {
            yield* provider.deprovision(key);
            relinked = yield* provider.provision(request);
            const allocation = allocations.allocations.get("user_ABC:env_ABC")!;
            allocations.allocations.set("user_ABC:env_ABC", {
              ...allocation,
              dnsRecordId: '{"_tag":"TearingDown"}',
            });
          }).pipe(Effect.orDie);
        });

        yield* Effect.gen(function* () {
          provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
          yield* provider.provision(request);
          armed = true;
          yield* provider.deprovision(key);

          // The relink's endpoint, token and allocation are intact for its own unlink to finish.
          expect({ pause, endpoints: [...edge.endpoints.keys()] }).toEqual({
            pause,
            endpoints: [relinked.runtime.endpointId],
          });
          expect(secrets(edge)).toEqual([relinked.runtime.connectorToken]);
          yield* provider.deprovision(key);
          expect(edge.endpoints.size + edge.tokens.size).toBe(0);
          expect(allocations.allocations.size).toBe(0);
          yield* provider.provision(request);
        }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
      }
    }),
  );

  it.effect("a provision finishing a stale unlink leaves the relink's allocation alone", () => {
    let provider!: Provider;
    let relinked!: ManagedEndpointProvider.ManagedEndpointProvisioningResult;
    let failRemoval = false;
    let armed = false;
    const edge = makeConnectEdge({ failApplyEndpointChange: () => failRemoval });
    // Right after this provision reads the half-unlinked allocation, a retried unlink finishes
    // it and a relink creates a new one.
    const allocations = makeAllocations({
      afterReserve: () =>
        Effect.suspend(() => {
          if (!armed) return Effect.void;
          armed = false;
          return Effect.gen(function* () {
            yield* provider.deprovision(key);
            relinked = yield* provider.provision(request);
          }).pipe(Effect.orDie);
        }),
    });

    return Effect.gen(function* () {
      provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision(request);
      failRemoval = true;
      yield* Effect.flip(provider.deprovision(key));
      failRemoval = false;
      armed = true;

      expect(yield* provider.provision(request)).toEqual(relinked);
      expect([...edge.endpoints.keys()]).toEqual([relinked.runtime.endpointId]);
      expect(secrets(edge)).toEqual([relinked.runtime.connectorToken]);
    }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
  });

  it.effect("relinks racing to recover an orphaned endpoint both adopt it", () => {
    let provider!: Provider;
    let second: ManagedEndpointProvider.ManagedEndpointProvisioningResult | undefined;
    // First an unlink lands between creating the endpoint and recording it; later a second
    // relink runs while the first is looking up the endpoint holding the hostname.
    let point = "CreateEndpoint";
    const edge = makeConnectEdge({
      afterCall: (method) => {
        if (method !== point) return Effect.void;
        if (point === "CreateEndpoint") {
          point = "ListEndpoints";
          return provider.deprovision(key).pipe(Effect.orDie);
        }
        point = "";
        return provider.provision(request).pipe(
          Effect.tap((result) => Effect.sync(() => (second = result))),
          Effect.orDie,
          Effect.asVoid,
        );
      },
    });

    return Effect.gen(function* () {
      provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      expect(yield* Effect.flip(provider.provision(request))).toMatchObject({
        stage: "record-endpoint",
        cause: { _tag: "ManagedEndpointUnlinked" },
      });
      edge.tokens.set("token-stray", "endpoint-1");

      const first = yield* provider.provision(request);
      expect(second).toEqual(first);
      expect(first.runtime.endpointId).toBe("endpoint-1");
      expect([...edge.endpoints.keys()]).toEqual(["endpoint-1"]);
      expect(secrets(edge)).toEqual([first.runtime.connectorToken]);
    }).pipe(Effect.provide(providerLayer(edge)));
  });

  it.effect("a stale provision never touches the endpoint a relink created", () => {
    let provider!: Provider;
    let relinked!: ManagedEndpointProvider.ManagedEndpointProvisioningResult;
    let armed = false;
    const edge = makeConnectEdge();
    // Right after this provision reads the allocation, an unlink completes and a relink
    // provisions a new endpoint under the same hostname.
    const allocations = makeAllocations({
      afterReserve: () =>
        Effect.suspend(() => {
          if (!armed) return Effect.void;
          armed = false;
          return Effect.gen(function* () {
            yield* provider.deprovision(key);
            relinked = yield* provider.provision(request);
          }).pipe(Effect.orDie);
        }),
    });

    return Effect.gen(function* () {
      provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision(request);
      armed = true;

      expect(yield* Effect.flip(provider.provision(request))).toMatchObject({
        stage: "record-endpoint",
        cause: { _tag: "ManagedEndpointUnlinked" },
      });
      expect([...edge.endpoints.keys()]).toEqual([relinked.runtime.endpointId]);
      expect(secrets(edge)).toEqual([relinked.runtime.connectorToken]);
      expect(edge.calls.filter((call) => call.method === "CreateConnectorToken")).toHaveLength(2);
    }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
  });

  it.effect("an unlink whose removal plan went stale plans again when retried", () => {
    let armed = true;
    // A token lands on the endpoint between the unlink's removal plan and its apply.
    const edge = makeConnectEdge({
      beforeCall: (method) =>
        Effect.sync(() => {
          if (!armed || method !== "ApplyEndpointChange") return;
          armed = false;
          edge.tokens.set("token-late", "endpoint-1");
        }),
    });
    const allocations = makeAllocations();

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision(request);
      expect(yield* Effect.flip(provider.deprovision(key))).toMatchObject({
        stage: "remove-endpoint",
      });
      yield* provider.deprovision(key);
      expect(edge.endpoints.size + edge.tokens.size).toBe(0);
      expect(allocations.allocations.size).toBe(0);
    }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
  });

  it.effect("an interrupted unlink is finished by the next provision or a retry", () => {
    let failRemoval = true;
    const edge = makeConnectEdge({ failApplyEndpointChange: () => failRemoval });
    const allocations = makeAllocations();

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision(request);
      expect(yield* Effect.flip(provider.deprovision(key))).toMatchObject({
        stage: "remove-endpoint",
      });
      failRemoval = false;

      const relinked = yield* provider.provision(request);
      expect([...edge.endpoints.keys()]).toEqual([relinked.runtime.endpointId]);
      expect(relinked.runtime.endpointId).not.toBe("endpoint-1");
      expect(secrets(edge)).toEqual([relinked.runtime.connectorToken]);

      failRemoval = true;
      yield* Effect.flip(provider.deprovision(key));
      failRemoval = false;
      yield* provider.deprovision(key);
      expect(edge.endpoints.size + edge.tokens.size).toBe(0);
      expect(allocations.allocations.size).toBe(0);
    }).pipe(Effect.provide(providerLayer(edge, allocations.service)));
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
