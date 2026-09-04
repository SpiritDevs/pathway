/**
 * Unit tests for the server's Convex sync transport and the service-token provider it presents on
 * every call.
 *
 * Everything here is hermetic: the relay is a fake `HttpClient` layer that mints tokens whose
 * claims are the shape {@link checkConvexServiceTokenClaims} demands, and Convex is a fake
 * {@link ConvexClientLike} that records the reference and arguments of every call. No socket is
 * opened and no `ConvexHttpClient` is constructed — that only happens on the default path, which is
 * exactly why the client is a seam.
 *
 * `it.effect` supplies a `TestClock`, which is what the token-expiry tests drive. The polling tests
 * use `it.live` and a one-millisecond interval instead: a fake Convex call resolves through a
 * promise, so a test that advanced a virtual clock would be racing the microtask queue for when the
 * poller re-arms its sleep. `Stream.take` waits for as many emissions as it needs, which cannot
 * flake on a slow machine either way.
 */
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@spiritdevs/contracts";
import {
  CompanyVersion,
  LocalSequence,
  SYNC_PROTOCOL_VERSION,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
  type SyncActor,
  type SyncOperationEnvelope,
} from "@spiritdevs/contracts/cloudSync";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import { RelayAccessTokenType, RelayConvexAudience } from "@spiritdevs/contracts/relay";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  generateDpopKeyPair,
  makeConvexServiceTokenProvider,
  nowEpochSeconds,
  type ConvexServiceTokenProvider,
  type ConvexServiceTokenProviderOptions,
} from "./convexServiceToken.ts";
import {
  classifyConvexFailure,
  makeConvexSyncTransport,
  type ConvexClientLike,
} from "./convexSyncTransport.ts";

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const RELAY_BASE_URL = "https://relay.example.test";
const CONVEX_URL = "https://deployment.convex.cloud";
const ENVIRONMENT_ID = EnvironmentId.make("env-transport-test");
const COMPANY_ID = CompanyId.make("company-transport-test");
const CLIENT_ID = SyncClientId.make("client-transport-test");
const ACTOR: SyncActor = { kind: "member", membershipId: MembershipId.make("membership-a") };

/** One ES256 proof key and one Ed25519 link key for the whole file: generating them is not free. */
const DPOP_KEYS = generateDpopKeyPair();
const LINK_KEYS = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const TOKEN_TTL_SECONDS = 300;

const identity = {
  environmentId: ENVIRONMENT_ID,
  relayBaseUrl: RELAY_BASE_URL,
  environmentCredential: "environment-credential-1",
  linkPrivateKey: LINK_KEYS.privateKey,
  dpopKeys: DPOP_KEYS,
} satisfies ConvexServiceTokenProviderOptions;

const encodeJoseSegment = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeSegment = (value: unknown): string =>
  Buffer.from(encodeJoseSegment(value), "utf8").toString("base64url");

/** The relay's own response body, encoded loosely so a test can post a shape the provider rejects. */
const encodeServiceTokenResponse = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      access_token: Schema.String,
      issued_token_type: Schema.String,
      token_type: Schema.String,
      expires_in: Schema.Number,
      audience: Schema.String,
    }),
  ),
);

const encodeRelayAuthError = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String, reason: Schema.String })),
);

/**
 * A token with the header and claims the relay's ES256 signing path produces. The signature is
 * filler: nothing under test verifies it (that is `verifyServiceTokenSignature`, which takes a JWKS
 * and is covered by the smoke's own tests), while every claim the provider checks is real.
 */
const mintFakeServiceToken = (input: {
  readonly issuedAtEpochSeconds: number;
  readonly serial: number;
}): string =>
  [
    encodeSegment({ alg: "ES256", kid: "relay-convex-signing-1", typ: "JWT" }),
    encodeSegment({
      iss: RELAY_BASE_URL,
      aud: RelayConvexAudience,
      sub: ENVIRONMENT_ID,
      environmentId: ENVIRONMENT_ID,
      jti: `service-token-${input.serial}`,
      iat: input.issuedAtEpochSeconds,
      exp: input.issuedAtEpochSeconds + TOKEN_TTL_SECONDS,
      cnf: { jkt: DPOP_KEYS.thumbprint },
    }),
    Buffer.from(`signature-${input.serial}`, "utf8").toString("base64url"),
  ].join(".");

interface RecordedExchange {
  readonly url: string;
  readonly params: URLSearchParams;
  readonly dpop: string | undefined;
}

interface RelayEndpoint {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly exchanges: ReadonlyArray<RecordedExchange>;
}

/**
 * A fake `POST {relay}/v1/environment/convex-token`.
 *
 * `gate` holds every response until the test opens it, which is how the single-flight test proves
 * three callers overlapped rather than merely that the second one hit a warm cache.
 */
const makeRelayEndpoint = (options?: {
  readonly gate?: Latch.Latch;
  readonly refuse?: { readonly status: number; readonly body: string };
  readonly unreachable?: boolean;
  readonly body?: string;
}): RelayEndpoint => {
  const exchanges: Array<RecordedExchange> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (options?.gate !== undefined) {
          yield* options.gate.await;
        }
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        exchanges.push({
          url: request.url,
          params: new URLSearchParams(body),
          dpop: request.headers["dpop"],
        });
        if (options?.unreachable === true) {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: "connect ECONNREFUSED",
            }),
          });
        }
        if (options?.refuse !== undefined) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(options.refuse.body, {
              status: options.refuse.status,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        const issuedAt = yield* nowEpochSeconds;
        const payload =
          options?.body ??
          encodeServiceTokenResponse({
            access_token: mintFakeServiceToken({
              issuedAtEpochSeconds: issuedAt,
              serial: exchanges.length,
            }),
            issued_token_type: RelayAccessTokenType,
            token_type: "Bearer",
            expires_in: TOKEN_TTL_SECONDS,
            audience: RelayConvexAudience,
          });
        return HttpClientResponse.fromWeb(
          request,
          new Response(payload, { status: 200, headers: { "content-type": "application/json" } }),
        );
      }),
    ),
  );
  return { layer, exchanges };
};

interface RecordedConvexCall {
  readonly kind: "query" | "mutation";
  /** `getFunctionName`, e.g. `sync:bootstrap`. */
  readonly name: string;
  readonly args: unknown;
  /** The bearer token installed when the call was issued. */
  readonly token: string | null;
}

interface FakeConvexClient {
  readonly client: ConvexClientLike;
  readonly calls: ReadonlyArray<RecordedConvexCall>;
}

/**
 * A fake Convex deployment. `respond` sees the function name, the arguments, and the zero-based
 * call index; returning an `Error` rejects the call, which is how the authorization and network
 * paths are driven.
 */
const makeFakeConvexClient = (
  respond: (call: RecordedConvexCall, index: number) => unknown,
): FakeConvexClient => {
  const calls: Array<RecordedConvexCall> = [];
  let token: string | null = null;
  const invoke = (
    kind: "query" | "mutation",
    reference: FunctionReference<"query" | "mutation">,
    args: unknown,
  ): Promise<unknown> => {
    const call: RecordedConvexCall = { kind, name: getFunctionName(reference), args, token };
    calls.push(call);
    const outcome = respond(call, calls.length - 1);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };
  const client: ConvexClientLike = {
    setAuth: (next) => {
      token = next;
    },
    query: ((reference: FunctionReference<"query">, args: unknown) =>
      invoke("query", reference, args)) as ConvexClientLike["query"],
    mutation: ((reference: FunctionReference<"mutation">, args: unknown) =>
      invoke("mutation", reference, args)) as ConvexClientLike["mutation"],
  };
  return { client, calls };
};

/** A token provider that never touches the network, for the transport tests that are not about auth. */
const staticTokenProvider = (tokens: ReadonlyArray<string>): ConvexServiceTokenProvider => {
  let index = 0;
  return {
    token: Effect.sync(() => tokens[Math.min(index, tokens.length - 1)] ?? "token"),
    invalidate: () =>
      Effect.sync(() => {
        index += 1;
      }),
  };
};

const latestVersionValue = (version: number) => ({
  version,
  authorizationEpoch: 4,
});

// --------------------------------------------------------------------------
// Service token provider
// --------------------------------------------------------------------------

describe("convex service token provider", () => {
  it.effect("exchanges once and serves the cached token to later callers", () =>
    Effect.gen(function* () {
      const relay = makeRelayEndpoint();
      const provider = yield* Effect.provide(makeConvexServiceTokenProvider(identity), relay.layer);

      const first = yield* provider.token;
      const second = yield* provider.token;

      assert.equal(first, second);
      assert.lengthOf(relay.exchanges, 1);
      const exchange = relay.exchanges[0];
      assert.isDefined(exchange);
      assert.equal(exchange.url, `${RELAY_BASE_URL}/v1/environment/convex-token`);
      assert.equal(exchange.params.get("audience"), RelayConvexAudience);
      assert.equal(exchange.params.get("subject_token"), "environment-credential-1");
      assert.isNotNull(exchange.params.get("key_binding"));
      // The proof is what binds the minted token to `cnf.jkt`; without it the relay refuses.
      assert.isDefined(exchange.dpop);
    }),
  );

  it.effect("performs one exchange for callers that arrive during the first one", () =>
    Effect.gen(function* () {
      const gate = yield* Latch.make(false);
      const relay = makeRelayEndpoint({ gate });
      const provider = yield* Effect.provide(makeConvexServiceTokenProvider(identity), relay.layer);

      const first = yield* Effect.forkChild(provider.token, { startImmediately: true });
      const second = yield* Effect.forkChild(provider.token, { startImmediately: true });
      const third = yield* Effect.forkChild(provider.token, { startImmediately: true });
      // All three are now inside the provider: one holds the mint permit and is blocked on the
      // relay, the other two are queued behind it.
      yield* Effect.yieldNow;
      yield* gate.open;

      const tokens = yield* Effect.all([Fiber.join(first), Fiber.join(second), Fiber.join(third)]);

      assert.lengthOf(relay.exchanges, 1);
      assert.equal(new Set(tokens).size, 1);
    }),
  );

  it.effect("refreshes proactively once the cached token enters the expiry margin", () =>
    Effect.gen(function* () {
      const relay = makeRelayEndpoint();
      const provider = yield* Effect.provide(
        makeConvexServiceTokenProvider({ ...identity, refreshMarginSeconds: 60 }),
        relay.layer,
      );

      const first = yield* provider.token;
      // Still outside the margin (expires at 300, margin 60): the cached token is handed back.
      yield* TestClock.adjust(Duration.seconds(200));
      assert.equal(yield* provider.token, first);
      assert.lengthOf(relay.exchanges, 1);

      // Inside the margin now, so the token is treated as already gone rather than used and refused.
      yield* TestClock.adjust(Duration.seconds(50));
      const refreshed = yield* provider.token;
      assert.notEqual(refreshed, first);
      assert.lengthOf(relay.exchanges, 2);
    }),
  );

  it.effect("invalidate drops only the token that was actually refused", () =>
    Effect.gen(function* () {
      const relay = makeRelayEndpoint();
      const provider = yield* Effect.provide(makeConvexServiceTokenProvider(identity), relay.layer);

      const first = yield* provider.token;
      // A stale token from a fiber that lost the race must not throw away the live one.
      yield* provider.invalidate("some-older-token");
      assert.equal(yield* provider.token, first);
      assert.lengthOf(relay.exchanges, 1);

      yield* provider.invalidate(first);
      const second = yield* provider.token;
      assert.notEqual(second, first);
      assert.lengthOf(relay.exchanges, 2);
    }),
  );

  it.effect("maps a refused exchange to unauthorized and names the relay's reason", () =>
    Effect.gen(function* () {
      const relay = makeRelayEndpoint({
        refuse: {
          status: 401,
          body: encodeRelayAuthError({ code: "auth_invalid", reason: "credential_revoked" }),
        },
      });
      const provider = yield* Effect.provide(makeConvexServiceTokenProvider(identity), relay.layer);

      const error = yield* Effect.flip(provider.token);
      assert.equal(error.reason, "unauthorized");
      assert.include(error.message, "credential_revoked");
    }),
  );

  it.effect("maps a relay outage to transport and keeps it retryable", () =>
    Effect.gen(function* () {
      const relay = makeRelayEndpoint({ refuse: { status: 503, body: "upstream unavailable" } });
      const provider = yield* Effect.provide(makeConvexServiceTokenProvider(identity), relay.layer);

      const error = yield* Effect.flip(provider.token);
      assert.equal(error.reason, "transport");
      assert.include(error.message, "503");
    }),
  );

  it.effect("maps an unreachable relay to offline", () =>
    Effect.gen(function* () {
      const relay = makeRelayEndpoint({ unreachable: true });
      const provider = yield* Effect.provide(makeConvexServiceTokenProvider(identity), relay.layer);

      const error = yield* Effect.flip(provider.token);
      assert.equal(error.reason, "offline");
    }),
  );

  it.effect("refuses a minted token whose claims are not the ones Convex authorizes on", () =>
    Effect.gen(function* () {
      const relay = makeRelayEndpoint({
        body: encodeServiceTokenResponse({
          access_token: [
            encodeSegment({ alg: "ES256", kid: "relay-convex-signing-1", typ: "JWT" }),
            encodeSegment({
              iss: RELAY_BASE_URL,
              aud: RelayConvexAudience,
              sub: ENVIRONMENT_ID,
              environmentId: ENVIRONMENT_ID,
              jti: "service-token-wrong-binding",
              iat: 0,
              exp: TOKEN_TTL_SECONDS,
              cnf: { jkt: "a-thumbprint-of-some-other-key" },
            }),
            Buffer.from("signature", "utf8").toString("base64url"),
          ].join("."),
          issued_token_type: RelayAccessTokenType,
          token_type: "Bearer",
          expires_in: TOKEN_TTL_SECONDS,
          audience: RelayConvexAudience,
        }),
      });
      const provider = yield* Effect.provide(makeConvexServiceTokenProvider(identity), relay.layer);

      const error = yield* Effect.flip(provider.token);
      assert.equal(error.reason, "unauthorized");
      assert.include(error.message, "cnf.jkt");
    }),
  );
});

// --------------------------------------------------------------------------
// Error classification
// --------------------------------------------------------------------------

describe("classifyConvexFailure", () => {
  it("maps a disabled or too-old deployment to upgrade-required", () => {
    assert.equal(
      classifyConvexFailure(new ConvexError({ code: "cloud-sync-disabled", message: "off" })),
      "upgrade-required",
    );
    assert.equal(
      classifyConvexFailure(new ConvexError({ code: "upgrade-required", message: "old" })),
      "upgrade-required",
    );
  });

  it("maps authorization refusals to unauthorized", () => {
    for (const code of [
      "not-authenticated",
      "not-a-member",
      "permission-denied",
      "company-not-found",
      "environment-key-mismatch",
    ]) {
      assert.equal(
        classifyConvexFailure(new ConvexError({ code, message: "no" })),
        "unauthorized",
        code,
      );
    }
  });

  it("maps a whole-batch refusal to upgrade-required rather than a retryable reason", () => {
    // The outbox rebuilds the same batch from the same entries every cycle, so a `transport` here
    // would resend a batch the deployment can only refuse again — forever, with every operation
    // queued behind it, and nothing said to the user.
    for (const code of [
      "batch-empty",
      "batch-too-large",
      "batch-args-too-large",
      "batch-duplicate-operation-id",
      "company-mismatch",
    ]) {
      assert.equal(
        classifyConvexFailure(new ConvexError({ code, message: "refused" })),
        "upgrade-required",
        code,
      );
    }
  });

  it("keeps invalid-arguments retryable, because a refused bootstrap cursor is retryable", () => {
    // `sync.bootstrap` answers `invalid-arguments` for a cursor it cannot decode, and the recovery
    // it asks for is a fresh seed — which is exactly what the engine's next cycle does.
    assert.equal(
      classifyConvexFailure(new ConvexError({ code: "invalid-arguments", message: "bad cursor" })),
      "transport",
    );
  });

  it("maps an HTTP 401 from Convex's own auth layer to unauthorized", () => {
    // Thrown before any handler runs, so there is no `ConvexError` to read a code from.
    assert.equal(
      classifyConvexFailure(new Error("Server Error: 401 Unauthorized")),
      "unauthorized",
    );
  });

  it("maps a socket that would not open to offline", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    assert.equal(classifyConvexFailure(new Error("fetch failed", { cause })), "offline");
    assert.equal(classifyConvexFailure(new TypeError("fetch failed")), "offline");
  });

  it("maps any other deployment decision to transport", () => {
    // A backend code this build does not know is still a decision, not a broken pipe: retrying is
    // right, but it is not an authorization or capability answer.
    assert.equal(
      classifyConvexFailure(new ConvexError({ code: "conflict", message: "retry" })),
      "transport",
    );
    assert.equal(classifyConvexFailure(new ConvexError("plain string payload")), "transport");
    assert.equal(classifyConvexFailure(new Error("something else went wrong")), "transport");
  });
});

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

describe("convex sync transport", () => {
  it.effect("passes each sync function the arguments the contract names", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient((call) => {
        switch (call.name) {
          case "sync:bootstrap":
            return { version: 3, authorizationEpoch: 4, entities: [], cursor: null, isDone: true };
          case "sync:listChanges":
            return {
              _tag: "Changes",
              changes: [],
              cursor: 9,
              authorizationEpoch: 4,
              hasMore: false,
            };
          case "sync:applyOperations":
            return { receipts: [], versionFrom: 3, versionTo: 4, authorizationEpoch: 4 };
          case "issueAttachments:urls":
            return [
              {
                attachmentId: "attachment-1",
                fileName: "evidence.png",
                mimeType: "image/png",
                byteSize: 3,
                url: "https://files.example.test/evidence.png",
              },
            ];
          default:
            return { prefix: "PW", blockStart: 1, blockEnd: 50, firstKey: "PW-1" };
        }
      });
      const transport = yield* makeConvexSyncTransport({
        convexUrl: CONVEX_URL,
        tokens: staticTokenProvider(["service-token-a"]),
        client: fake.client,
      });

      yield* transport.bootstrap({ companyId: COMPANY_ID, cursor: null, pageSize: 25 });
      yield* transport.listChanges({
        companyId: COMPANY_ID,
        cursor: CompanyVersion.make(7),
        limit: 100,
      });
      yield* transport.applyOperations({
        companyId: COMPANY_ID,
        operations: [operationEnvelope()],
      });
      yield* transport.reserveIssueKeys({
        companyId: COMPANY_ID,
        clientId: CLIENT_ID,
        blockSize: 50,
      });
      yield* transport.issueAttachmentUrls!({
        companyId: COMPANY_ID,
        issueId: "issue-1",
        attachmentIds: ["attachment-1"],
      });

      assert.deepEqual(
        fake.calls.map((call) => [call.kind, call.name]),
        [
          ["query", "sync:bootstrap"],
          ["query", "sync:listChanges"],
          ["mutation", "sync:applyOperations"],
          ["mutation", "sync:reserveIssueKeys"],
          ["query", "issueAttachments:urls"],
        ],
      );
      assert.deepEqual(fake.calls[0]?.args, {
        companyId: COMPANY_ID,
        cursor: null,
        pageSize: 25,
      });
      assert.deepEqual(fake.calls[1]?.args, { companyId: COMPANY_ID, cursor: 7, limit: 100 });
      assert.deepEqual(fake.calls[2]?.args, {
        companyId: COMPANY_ID,
        operations: [
          {
            protocolVersion: SYNC_PROTOCOL_VERSION,
            operationId: "op-1",
            companyId: COMPANY_ID,
            clientId: CLIENT_ID,
            environmentId: null,
            actor: { kind: "member", membershipId: "membership-a" },
            localSequence: 1,
            baseVersion: 3,
            kind: "issue.update",
            entityId: "issue-a",
            args: { _tag: "IssueUpdate", title: "renamed" },
            dependsOn: [],
          },
        ],
      });
      assert.deepEqual(fake.calls[4]?.args, {
        companyId: COMPANY_ID,
        issueId: "issue-1",
        attachmentIds: ["attachment-1"],
      });
      assert.deepEqual(fake.calls[3]?.args, {
        companyId: COMPANY_ID,
        clientId: CLIENT_ID,
        blockSize: 50,
      });
      // Every call presents the service token, installed before it is issued.
      assert.deepEqual(new Set(fake.calls.map((call) => call.token)), new Set(["service-token-a"]));
    }),
  );

  it.effect("omits optional arguments the caller left out rather than sending undefined", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient((call) =>
        call.name === "sync:bootstrap"
          ? { version: 3, authorizationEpoch: 4, entities: [], cursor: null, isDone: true }
          : call.name === "sync:listChanges"
            ? { _tag: "Changes", changes: [], cursor: 7, authorizationEpoch: 4, hasMore: false }
            : { prefix: "PW", blockStart: 1, blockEnd: 50, firstKey: "PW-1" },
      );
      const transport = yield* makeConvexSyncTransport({
        convexUrl: CONVEX_URL,
        tokens: staticTokenProvider(["service-token-a"]),
        client: fake.client,
      });

      yield* transport.bootstrap({ companyId: COMPANY_ID, cursor: null });
      yield* transport.listChanges({ companyId: COMPANY_ID, cursor: CompanyVersion.make(7) });
      yield* transport.reserveIssueKeys({ companyId: COMPANY_ID, clientId: CLIENT_ID });

      // Convex validators reject an explicit `undefined` where an optional field is expected.
      assert.deepEqual(Object.keys(fake.calls[0]?.args as object), ["companyId", "cursor"]);
      assert.deepEqual(Object.keys(fake.calls[1]?.args as object), ["companyId", "cursor"]);
      assert.deepEqual(Object.keys(fake.calls[2]?.args as object), ["companyId", "clientId"]);
    }),
  );

  it.effect("refreshes the token once and retries a call the deployment refused", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient((_call, index) =>
        index === 0
          ? new ConvexError({ code: "not-authenticated", message: "token expired" })
          : { version: 11, authorizationEpoch: 4 },
      );
      const transport = yield* makeConvexSyncTransport({
        convexUrl: CONVEX_URL,
        tokens: staticTokenProvider(["service-token-a", "service-token-b"]),
        client: fake.client,
        pollIntervalMs: 60_000,
      });

      const emitted = yield* Stream.runCollect(
        transport.latestVersion({ companyId: COMPANY_ID }).pipe(Stream.take(1)),
      );

      assert.deepEqual(emitted, [{ version: 11, authorizationEpoch: 4 }]);
      assert.lengthOf(fake.calls, 2);
      // The retry is what makes a token that expired in flight invisible to the engine.
      assert.equal(fake.calls[0]?.token, "service-token-a");
      assert.equal(fake.calls[1]?.token, "service-token-b");
    }),
  );

  it.effect("does not retry a second time when the fresh token is refused too", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient(
        () => new ConvexError({ code: "not-a-member", message: "not a member" }),
      );
      const transport = yield* makeConvexSyncTransport({
        convexUrl: CONVEX_URL,
        tokens: staticTokenProvider(["service-token-a", "service-token-b"]),
        client: fake.client,
      });

      const error = yield* Effect.flip(
        transport.listChanges({ companyId: COMPANY_ID, cursor: CompanyVersion.make(1) }),
      );

      assert.equal(error.reason, "unauthorized");
      assert.lengthOf(fake.calls, 2);
    }),
  );

  it.effect("does not retry a failure that is not an authorization one", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient(() => new Error("fetch failed"));
      const transport = yield* makeConvexSyncTransport({
        convexUrl: CONVEX_URL,
        tokens: staticTokenProvider(["service-token-a"]),
        client: fake.client,
      });

      const error = yield* Effect.flip(
        transport.listChanges({ companyId: COMPANY_ID, cursor: CompanyVersion.make(1) }),
      );

      assert.equal(error.reason, "offline");
      assert.lengthOf(fake.calls, 1);
    }),
  );

  it.effect("reports a batch the deployment refused whole as terminal, once", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient(
        () =>
          new ConvexError({
            code: "batch-args-too-large",
            message: "Operation arguments exceed 524288 bytes.",
          }),
      );
      const transport = yield* makeConvexSyncTransport({
        convexUrl: CONVEX_URL,
        tokens: staticTokenProvider(["service-token-a", "service-token-b"]),
        client: fake.client,
      });

      const error = yield* Effect.flip(
        transport.applyOperations({ companyId: COMPANY_ID, operations: [operationEnvelope()] }),
      );

      // Terminal, so the engine stops and shows the deployment's message instead of resending a
      // batch it can only refuse again.
      assert.equal(error.reason, "upgrade-required");
      assert.include(error.message, "524288");
      assert.lengthOf(fake.calls, 1);
    }),
  );

  it.effect("surfaces a token the provider could not mint as the provider's own reason", () =>
    Effect.gen(function* () {
      const relay = makeRelayEndpoint({ unreachable: true });
      const tokens = yield* Effect.provide(makeConvexServiceTokenProvider(identity), relay.layer);
      const fake = makeFakeConvexClient(() => ({ version: 1, authorizationEpoch: 1 }));
      const transport = yield* makeConvexSyncTransport({
        convexUrl: CONVEX_URL,
        tokens,
        client: fake.client,
      });

      const error = yield* Effect.flip(
        transport.listChanges({ companyId: COMPANY_ID, cursor: CompanyVersion.make(1) }),
      );

      assert.equal(error.reason, "offline");
      // No token, so nothing was ever presented to the deployment.
      assert.lengthOf(fake.calls, 0);
    }),
  );

  it.effect("emits the first version immediately rather than after one poll interval", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient(() => latestVersionValue(5));
      const transport = yield* makeConvexSyncTransport({
        convexUrl: CONVEX_URL,
        tokens: staticTokenProvider(["service-token-a"]),
        client: fake.client,
        // An interval no test would ever wait out: a first emission that was not immediate would
        // hang here instead of passing.
        pollIntervalMs: 600_000,
      });

      const emitted = yield* Stream.runCollect(
        transport.latestVersion({ companyId: COMPANY_ID }).pipe(Stream.take(1)),
      );

      assert.deepEqual(emitted, [{ version: 5, authorizationEpoch: 4 }]);
      assert.deepEqual(fake.calls[0]?.args, { companyId: COMPANY_ID });
    }),
  );

  it.live("polls the head and emits only versions that actually moved", () =>
    Effect.gen(function* () {
      const versions = [5, 5, 5, 8, 8, 13, 13];
      const fake = makeFakeConvexClient((_call, index) =>
        latestVersionValue(versions[Math.min(index, versions.length - 1)] ?? 13),
      );
      const transport = yield* makeConvexSyncTransport({
        convexUrl: CONVEX_URL,
        tokens: staticTokenProvider(["service-token-a"]),
        client: fake.client,
        pollIntervalMs: 1,
      });

      const emitted = yield* Stream.runCollect(
        transport.latestVersion({ companyId: COMPANY_ID }).pipe(Stream.take(3)),
      );

      // Without the deduplication the engine would run a full sync pass every interval forever.
      assert.deepEqual(
        emitted.map((value) => value.version),
        [5, 8, 13],
      );
      assert.isAtLeast(fake.calls.length, 6);
    }),
  );

  it.live("stops polling when the subscriber goes away", () =>
    Effect.gen(function* () {
      const observed = yield* Ref.make(0);
      const fake = makeFakeConvexClient((_call, index) => latestVersionValue(index));
      const transport = yield* makeConvexSyncTransport({
        convexUrl: CONVEX_URL,
        tokens: staticTokenProvider(["service-token-a"]),
        client: fake.client,
        pollIntervalMs: 1,
      });

      const fiber = yield* Effect.forkChild(
        Stream.runForEach(transport.latestVersion({ companyId: COMPANY_ID }), () =>
          Ref.update(observed, (count) => count + 1),
        ),
        { startImmediately: true },
      );
      yield* Effect.sleep(Duration.millis(20));
      yield* Fiber.interrupt(fiber);
      const atInterrupt = fake.calls.length;
      assert.isAtLeast(yield* Ref.get(observed), 1);

      // A poller that outlived its subscriber would keep querying the deployment forever.
      yield* Effect.sleep(Duration.millis(25));
      assert.equal(fake.calls.length, atInterrupt);
    }),
  );
});

function operationEnvelope(): SyncOperationEnvelope {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    operationId: SyncOperationId.make("op-1"),
    companyId: COMPANY_ID,
    clientId: CLIENT_ID,
    environmentId: null,
    actor: ACTOR,
    localSequence: LocalSequence.make(1),
    baseVersion: CompanyVersion.make(3),
    kind: "issue.update",
    entityId: SyncEntityId.make("issue-a"),
    args: { _tag: "IssueUpdate", title: "renamed" },
    dependsOn: [],
  };
}
