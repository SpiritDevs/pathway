import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpServerRequest } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AuthComputerOperateScope,
  AuthPeerEnvironmentScopes,
  AuthPeerReadGrantPermission,
  AuthPeerReadScopes,
  AuthPeerSendGrantPermission,
  AuthPeerSendScopes,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSessionId,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentId,
  type EnvironmentSessionPrincipalShape,
} from "@spiritdevs/contracts";
import {
  type RelayCloudMintCredentialProofPayload,
  RelayEnvironmentConnectReadScope,
  RelayEnvironmentConnectSendScope,
  type RelayValidatedConnectGrantIdentity,
} from "@spiritdevs/contracts/relay";
import { RelayClientTracer } from "@spiritdevs/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_MINT_REQUEST_TYP,
  signRelayJwt,
} from "@spiritdevs/shared/relayJwt";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import type { RelayLinkProofRequest } from "@spiritdevs/contracts/relay";
import {
  CLOUD_MANAGED_TUNNEL_LOCAL_PORT,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import {
  applyCloudRelayConfig,
  authorizeCloudLinkOrigin,
  type CloudHttpDependencies,
  cloudMintCredentialHandler,
  consumeCloudReplayGuards,
  isSupportedLinkProviderKind,
  linkProofScopes,
  managedTunnelLocalPortFromRequest,
  readCloudLinkState,
  reconcileDesiredCloudLink,
} from "./http.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "./traceRelayRequest.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new ServerSecretStore.SecretStorePersistError({
    resource: "cloud replay guard",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "cloud-replay-guard.bin",
    }),
  });

const unusedSecretStoreOperation = () => Effect.die("unused secret-store operation");

function makeSecretStore(
  create: ServerSecretStore.ServerSecretStore["Service"]["create"],
): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: unusedSecretStoreOperation,
    set: unusedSecretStoreOperation,
    create,
    getOrCreateRandom: unusedSecretStoreOperation,
    remove: unusedSecretStoreOperation,
  };
}

it("preserves messages surfaced by cloud 500 responses", () => {
  const cause = new Error("cloud operation failed");

  expect([
    new EnvironmentAuth.ServerAuthLinkedCloudAccountVerificationError({ cause }).message,
    new EnvironmentAuth.ServerAuthLinkedCloudAccountReadError({ cause }).message,
    new EnvironmentAuth.ServerAuthLinkedCloudAccountMissingError({}).message,
    new EnvironmentAuth.ServerAuthCloudLinkJwtSigningError({ cause }).message,
    new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({}).message,
    new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({}).message,
    new EnvironmentAuth.ServerAuthCloudHealthJwtSigningError({ cause }).message,
    new EnvironmentAuth.ServerAuthCloudMintJwtSigningError({ cause }).message,
  ]).toEqual([
    "Could not verify the linked cloud account.",
    "Could not read the linked cloud account.",
    "Cloud linked user is not installed for this environment.",
    "Failed to sign cloud link JWT.",
    "Cloud mint public key is not installed for this environment.",
    "Cloud relay issuer is not installed for this environment.",
    "Failed to sign cloud health JWT.",
    "Failed to sign cloud mint JWT.",
  ]);
});

describe("consumeCloudReplayGuards", () => {
  it.effect("reports already-created guards as replay conflicts", () =>
    Effect.gen(function* () {
      const consumed = yield* consumeCloudReplayGuards({
        secrets: makeSecretStore(() => Effect.fail(storeFailure("AlreadyExists"))),
        names: ["cloud-jti", "cloud-nonce"],
        value: new Uint8Array(),
      });

      expect(consumed).toBe(false);
    }),
  );

  it.effect("preserves replay-store availability failures", () =>
    Effect.gen(function* () {
      const failure = storeFailure("PermissionDenied");
      const error = yield* Effect.flip(
        consumeCloudReplayGuards({
          secrets: makeSecretStore(() => Effect.fail(failure)),
          names: ["cloud-jti", "cloud-nonce"],
          value: new Uint8Array(),
        }),
      );

      expect(error).toBe(failure);
    }),
  );
});

describe("cloud mint credential handler", () => {
  const TARGET_ENVIRONMENT_ID = EnvironmentId.make("environment-target");
  const INITIATING_ENVIRONMENT_ID = EnvironmentId.make("environment-initiating");
  const RELAY_ISSUER = "https://relay.example.test";
  const LINKED_CLOUD_USER_ID = "cloud-user-linked";
  const ACTING_CLOUD_USER_ID = "cloud-user-acting";
  const relayKeys = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const connectGrant: RelayValidatedConnectGrantIdentity = {
    environmentId: TARGET_ENVIRONMENT_ID,
    membershipId: "membership-acting" as never,
    permission: "remoteAgents.control",
  };

  interface MintHarnessOptions {
    readonly environmentSubject?: boolean;
    readonly clientEnvironmentId?: EnvironmentId;
    readonly includeConnectGrant?: boolean;
    readonly resolvedActor?: string | null;
    readonly connectGrant?: RelayValidatedConnectGrantIdentity;
    readonly scope?: RelayCloudMintCredentialProofPayload["scope"];
  }

  const makeMintHarness = Effect.fn("CloudHttpTest.makeMintHarness")(function* (
    options: MintHarnessOptions = {},
  ) {
    const encoded = (value: string) => new TextEncoder().encode(value);
    const secrets = new Map<string, Uint8Array>([
      [CLOUD_MINT_PUBLIC_KEY, encoded(relayKeys.publicKey)],
      [RELAY_ISSUER_SECRET, encoded(RELAY_ISSUER)],
      [CLOUD_LINKED_USER_ID, encoded(LINKED_CLOUD_USER_ID)],
    ]);
    const secretReads: string[] = [];
    const secretCreates: string[] = [];
    const secretStore: ServerSecretStore.ServerSecretStore["Service"] = {
      get: (name) =>
        Effect.sync(() => {
          secretReads.push(name);
          return Option.fromUndefinedOr(secrets.get(name));
        }),
      set: (name, value) =>
        Effect.sync(() => {
          secrets.set(name, value);
        }),
      create: (name, value) =>
        Effect.sync(() => {
          secretCreates.push(name);
          secrets.set(name, value);
        }),
      getOrCreateRandom: unusedSecretStoreOperation,
      remove: (name) =>
        Effect.sync(() => {
          secrets.delete(name);
        }),
    };
    const pairingInputs: Array<
      NonNullable<Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"]>[0]>
    > = [];
    const environmentAuth = EnvironmentAuth.EnvironmentAuth.of({
      createPairingLink: (
        input: Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"]>[0],
      ) =>
        Effect.gen(function* () {
          pairingInputs.push(input ?? {});
          const createdAt = DateTime.toUtc(yield* DateTime.now);
          return {
            id: "pairing-link-id",
            credential: "target-bootstrap-credential",
            scopes: input?.scopes ?? [],
            subject: input?.subject ?? "one-time-token",
            ...(input?.initiatingEnvironmentId
              ? { initiatingEnvironmentId: input.initiatingEnvironmentId }
              : {}),
            ...(input?.label ? { label: input.label } : {}),
            createdAt,
            expiresAt: DateTime.toUtc(DateTime.add(createdAt, { minutes: 2 })),
          };
        }),
    } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);
    const dependencies: CloudHttpDependencies = {
      secrets: secretStore,
      environment: ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(TARGET_ENVIRONMENT_ID),
        getDescriptor: Effect.die("unused environment descriptor"),
      }),
      endpointRuntime: ManagedEndpointRuntime.CloudManagedEndpointRuntime.of(
        {} as ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"],
      ),
      environmentAuth,
      cliTokenManager: CliTokenManager.CloudCliTokenManager.of(
        {} as CliTokenManager.CloudCliTokenManager["Service"],
      ),
      httpClient: HttpClient.make(() => Effect.die("unused HTTP client")),
      authorizeConnectGrant: () => Effect.succeed(true),
      resolveConnectGrantActor: () =>
        Effect.succeed(
          options.resolvedActor === undefined ? ACTING_CLOUD_USER_ID : options.resolvedActor,
        ),
    };
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const environmentSubject = options.environmentSubject === true;
    const includeConnectGrant = options.includeConnectGrant !== false;
    const payload = {
      iss: normalizeRelayIssuer(RELAY_ISSUER),
      aud: `pathway-env:${TARGET_ENVIRONMENT_ID}`,
      sub: environmentSubject ? INITIATING_ENVIRONMENT_ID : LINKED_CLOUD_USER_ID,
      jti: "mint-proof-jti",
      iat: nowSeconds,
      exp: nowSeconds + 120,
      environmentId: TARGET_ENVIRONMENT_ID,
      ...(environmentSubject ? { initiatingEnvironmentId: INITIATING_ENVIRONMENT_ID } : {}),
      ...(options.clientEnvironmentId ? { clientEnvironmentId: options.clientEnvironmentId } : {}),
      clientProofKeyThumbprint: "client-proof-thumbprint",
      cnf: { jkt: "client-proof-thumbprint" },
      ...(includeConnectGrant ? { connectGrant: options.connectGrant ?? connectGrant } : {}),
      nonce: "mint-proof-nonce",
      scope: options.scope ?? ["environment:connect"],
    } satisfies RelayCloudMintCredentialProofPayload;
    const proof = yield* signRelayJwt({
      privateKey: relayKeys.privateKey,
      typ: RELAY_MINT_REQUEST_TYP,
      payload,
    });
    const request = HttpServerRequest.fromWeb(
      new Request("https://target.example.test/api/pathway-cloud/mint-credential"),
    );
    const run = cloudMintCredentialHandler(dependencies, { proof }).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(
        SqlClient.SqlClient,
        SqlClient.SqlClient.of({} as Parameters<typeof SqlClient.SqlClient.of>[0]),
      ),
      Effect.provide(NodeServices.layer),
    );

    return { run, pairingInputs, secretReads, secretCreates };
  });

  it.effect("mints an environment-subject credential for the replica-resolved user", () =>
    Effect.gen(function* () {
      const harness = yield* makeMintHarness({ environmentSubject: true });
      const result = yield* harness.run;

      expect(result.credential).toBe("target-bootstrap-credential");
      expect(harness.pairingInputs).toHaveLength(1);
      expect(harness.pairingInputs[0]).toMatchObject({
        subject: ACTING_CLOUD_USER_ID,
        initiatingEnvironmentId: INITIATING_ENVIRONMENT_ID,
      });
      expect(harness.secretReads).not.toContain(CLOUD_LINKED_USER_ID);
    }),
  );

  it.effect(
    "refuses an environment subject without grant identity before consuming replay guards",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeMintHarness({
          environmentSubject: true,
          includeConnectGrant: false,
        });
        const error = yield* Effect.flip(harness.run);

        expect(error).toMatchObject({
          _tag: "EnvironmentHttpUnauthorizedError",
          message: "Invalid cloud mint request.",
        });
        expect(harness.pairingInputs).toEqual([]);
        expect(harness.secretCreates).toEqual([]);
      }),
  );

  it.effect("refuses an environment subject whose grant user is absent from the replica", () =>
    Effect.gen(function* () {
      const harness = yield* makeMintHarness({
        environmentSubject: true,
        resolvedActor: null,
      });
      const error = yield* Effect.flip(harness.run);

      expect(error).toMatchObject({
        _tag: "EnvironmentHttpUnauthorizedError",
        message: "Invalid cloud mint request.",
      });
      expect(harness.pairingInputs).toEqual([]);
      expect(harness.secretCreates).toEqual([]);
    }),
  );

  it.effect("keeps user-subject credential identity unchanged", () =>
    Effect.gen(function* () {
      const harness = yield* makeMintHarness();
      yield* harness.run;

      expect(harness.pairingInputs).toHaveLength(1);
      expect(harness.pairingInputs[0]?.subject).toBe("cloud-connect");
      expect(harness.pairingInputs[0]?.clerkSubject).toBe(LINKED_CLOUD_USER_ID);
      expect(harness.pairingInputs[0]?.initiatingEnvironmentId).toBeUndefined();
      expect(harness.secretReads).toContain(CLOUD_LINKED_USER_ID);
    }),
  );

  it.effect("keeps ordinary peer scopes for untagged grants signed with the connect scope", () =>
    Effect.gen(function* () {
      // Caller-supplied remote-dispatch grants (status queries use environments.read) predate thread
      // grants; older callers still request the ordinary peer scopes from updated targets.
      for (const permission of [AuthPeerReadGrantPermission, AuthPeerSendGrantPermission]) {
        const peer = yield* makeMintHarness({
          environmentSubject: true,
          connectGrant: { ...connectGrant, permission },
        });
        yield* peer.run;
        expect(peer.pairingInputs[0]?.scopes).toEqual(AuthPeerEnvironmentScopes);
      }
    }),
  );

  it.effect("mints read-only scopes for the read mint scope and only for peers", () =>
    Effect.gen(function* () {
      const reader = yield* makeMintHarness({
        environmentSubject: true,
        scope: [RelayEnvironmentConnectReadScope],
      });
      yield* reader.run;
      expect(reader.pairingInputs[0]?.scopes).toEqual(AuthPeerReadScopes);

      const person = yield* makeMintHarness({ scope: [RelayEnvironmentConnectReadScope] });
      const refused = yield* Effect.flip(person.run);
      expect(refused).toMatchObject({ _tag: "EnvironmentHttpUnauthorizedError" });
      expect(person.pairingInputs).toEqual([]);
    }),
  );

  it.effect("mints read-and-dispatch scopes for the send mint scope and only for peers", () =>
    Effect.gen(function* () {
      const sender = yield* makeMintHarness({
        environmentSubject: true,
        scope: [RelayEnvironmentConnectSendScope],
      });
      yield* sender.run;
      expect(sender.pairingInputs[0]?.scopes).toEqual(AuthPeerSendScopes);
      expect(sender.pairingInputs[0]?.scopes).not.toContain(AuthTerminalOperateScope);
      expect(sender.pairingInputs[0]?.scopes).not.toContain(AuthReviewWriteScope);

      const person = yield* makeMintHarness({ scope: [RelayEnvironmentConnectSendScope] });
      expect(yield* Effect.flip(person.run)).toMatchObject({
        _tag: "EnvironmentHttpUnauthorizedError",
      });
      expect(person.pairingInputs).toEqual([]);
    }),
  );

  it("is rejected by targets that predate the thread-access mint scopes", () => {
    // The mint-proof scope schema before the read scope existed. Such a target can never mint a
    // full peer session from a read grant signed by a current relay.
    const decodePreReadScope = Schema.decodeUnknownOption(
      Schema.Array(Schema.Literal("environment:connect")),
    );
    expect(Option.isNone(decodePreReadScope([RelayEnvironmentConnectReadScope]))).toBe(true);
    expect(Option.isNone(decodePreReadScope([RelayEnvironmentConnectSendScope]))).toBe(true);
    expect(Option.isSome(decodePreReadScope(["environment:connect"]))).toBe(true);
  });

  it.effect("never lets a peer environment drive this desktop", () =>
    Effect.gen(function* () {
      const peer = yield* makeMintHarness({ environmentSubject: true });
      yield* peer.run;
      expect(peer.pairingInputs[0]?.scopes).not.toContain(AuthComputerOperateScope);

      // A person's own client, even one hosted in an environment, keeps it.
      const desktop = yield* makeMintHarness({ clientEnvironmentId: INITIATING_ENVIRONMENT_ID });
      yield* desktop.run;
      expect(desktop.pairingInputs[0]?.scopes).toContain(AuthComputerOperateScope);
    }),
  );

  it.effect("attributes a user-subject desktop credential to its hosted environment", () =>
    Effect.gen(function* () {
      const harness = yield* makeMintHarness({
        clientEnvironmentId: INITIATING_ENVIRONMENT_ID,
      });
      yield* harness.run;

      expect(harness.pairingInputs[0]).toMatchObject({
        subject: "cloud-connect",
        initiatingEnvironmentId: INITIATING_ENVIRONMENT_ID,
      });
    }),
  );
});

describe("relay request tracing", () => {
  it.effect("does not accept an unauthenticated request trace parent", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.Span> = [];
      const productTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://environment.example.test/api/pathway-cloud/mint-credential", {
          headers: {
            traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          },
        }),
      );

      yield* traceRelayRequest(Effect.void.pipe(Effect.withSpan("relay.mint.handler"))).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
      );

      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.traceId).not.toBe("0123456789abcdef0123456789abcdef");
      expect(Option.isNone(span.parent)).toBe(true);
    }),
  );

  it.effect("continues an authenticated relay trace with the product tracer", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.Span> = [];
      const productTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://environment.example.test/api/pathway-cloud/mint-credential", {
          headers: {
            traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          },
        }),
      );

      yield* traceAuthenticatedRelayRequest(
        Effect.void.pipe(Effect.withSpan("relay.mint.handler")),
      ).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
      );

      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.traceId).toBe("0123456789abcdef0123456789abcdef");
      expect(Option.getOrUndefined(span.parent)?.spanId).toBe("0123456789abcdef");
    }),
  );
});

describe("reconcileDesiredCloudLink", () => {
  it.effect("requires stored CLI authorization without exposing an HTTP endpoint", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(reconcileDesiredCloudLink("http://127.0.0.1:3774"));

      expect(error).toMatchObject({
        _tag: "EnvironmentHttpUnauthorizedError",
        message: "Run `pathway connect link` to authorize this environment.",
      });
    }).pipe(
      Effect.provideService(
        ServerSecretStore.ServerSecretStore,
        makeSecretStore(unusedSecretStoreOperation),
      ),
      Effect.provideService(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: unusedSecretStoreOperation(),
          getDescriptor: unusedSecretStoreOperation(),
        }),
      ),
      Effect.provideService(
        ManagedEndpointRuntime.CloudManagedEndpointRuntime,
        ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
          applyConfig: unusedSecretStoreOperation,
        } satisfies ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"]),
      ),
      Effect.provideService(
        EnvironmentAuth.EnvironmentAuth,
        EnvironmentAuth.EnvironmentAuth.of({} as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Effect.provideService(
        CliTokenManager.CloudCliTokenManager,
        CliTokenManager.CloudCliTokenManager.of({
          get: unusedSecretStoreOperation(),
          getExisting: Effect.succeed(Option.none()),
          hasCredential: unusedSecretStoreOperation(),
          store: () => unusedSecretStoreOperation(),
          clear: unusedSecretStoreOperation(),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => unusedSecretStoreOperation()),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("link proof provider kinds", () => {
  const proofRequest = (
    providerKind: RelayLinkProofRequest["endpoint"]["providerKind"],
  ): RelayLinkProofRequest => ({
    challenge: "challenge",
    relayIssuer: "https://relay.example.test",
    endpoint: {
      httpBaseUrl: "http://127.0.0.1:7331",
      wsBaseUrl: "ws://127.0.0.1:7331",
      providerKind,
    },
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 7331 },
  });

  it("accepts managed and manual endpoints but not pathway_relay", () => {
    expect(isSupportedLinkProviderKind(proofRequest("cloudflare_tunnel"))).toBe(true);
    expect(isSupportedLinkProviderKind(proofRequest("manual"))).toBe(true);
    expect(isSupportedLinkProviderKind(proofRequest("pathway_relay"))).toBe(false);
  });

  it("only claims the managed-tunnel scope for tunnel links", () => {
    expect(linkProofScopes(proofRequest("cloudflare_tunnel"))).toEqual([
      "agent_activity_notifications",
      "managed_tunnels",
    ]);
    expect(linkProofScopes(proofRequest("manual"))).toEqual(["agent_activity_notifications"]);
  });

  it("records managed tunnel ports only from direct loopback requests", () => {
    expect(
      managedTunnelLocalPortFromRequest(
        HttpServerRequest.fromWeb(new Request("http://127.0.0.1:3800/api/connect/relay-config")),
      ),
    ).toBe(3_800);
    expect(
      managedTunnelLocalPortFromRequest(
        HttpServerRequest.fromWeb(
          new Request("http://127.0.0.1:3800/api/connect/relay-config", {
            headers: { "x-forwarded-host": "public.example.test" },
          }),
        ),
      ),
    ).toBeNull();
    expect(
      managedTunnelLocalPortFromRequest(
        HttpServerRequest.fromWeb(
          new Request("https://public.example.test/api/connect/relay-config"),
        ),
      ),
    ).toBeNull();
  });
});

describe("cloud relay config replacement", () => {
  it.effect("adopts the newly proven account without requiring the stale local link", () =>
    Effect.gen(function* () {
      const encoded = (value: string) => new TextEncoder().encode(value);
      const values = new Map<string, Uint8Array>([
        [CLOUD_LINKED_USER_ID, encoded("stale-user")],
        [RELAY_URL_SECRET, encoded("https://relay.example.test")],
      ]);
      const reads: string[] = [];
      const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
        get: (name) =>
          Effect.sync(() => {
            reads.push(name);
            return Option.fromNullishOr(values.get(name));
          }),
        set: (name, value) =>
          Effect.sync(() => {
            values.set(name, value);
          }),
        create: unusedSecretStoreOperation,
        getOrCreateRandom: unusedSecretStoreOperation,
        remove: (name) =>
          Effect.sync(() => {
            values.delete(name);
          }),
      };
      const cloudMintPublicKey = NodeCrypto.generateKeyPairSync("ed25519", {
        publicKeyEncoding: { format: "pem", type: "spki" },
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
      }).publicKey;
      const dependencies = {
        secrets,
        endpointRuntime: ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
          applyConfig: () => Effect.succeed({ status: "disabled" }),
        }),
      } as CloudHttpDependencies;

      yield* applyCloudRelayConfig(dependencies, {
        relayUrl: "https://relay.example.test",
        relayIssuer: "https://relay.example.test",
        cloudUserId: "current-user",
        environmentCredential: "current-credential",
        cloudMintPublicKey,
        endpointRuntime: null,
      });

      expect(new TextDecoder().decode(values.get(CLOUD_LINKED_USER_ID))).toBe("current-user");
      expect(reads).not.toContain(CLOUD_LINKED_USER_ID);
    }),
  );

  it.effect("persists and reports the local port installed in a managed tunnel", () =>
    Effect.gen(function* () {
      const encoded = (value: string) => new TextEncoder().encode(value);
      const values = new Map<string, Uint8Array>();
      const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
        get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
        set: (name, value) =>
          Effect.sync(() => {
            values.set(name, value);
          }),
        create: unusedSecretStoreOperation,
        getOrCreateRandom: unusedSecretStoreOperation,
        remove: (name) =>
          Effect.sync(() => {
            values.delete(name);
          }),
      };
      const cloudMintPublicKey = NodeCrypto.generateKeyPairSync("ed25519", {
        publicKeyEncoding: { format: "pem", type: "spki" },
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
      }).publicKey;
      const runtimeConfig = {
        environmentId: EnvironmentId.make("environment-1"),
        edgeUrl: "wss://edge.example.test/connect/v1",
        endpointId: "endpoint-1",
        connectorToken: "connector-token",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3_800 },
      };
      const dependencies = {
        secrets,
        currentLocalHttpPort: 3_800,
        endpointRuntime: ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
          applyConfig: () =>
            Effect.succeed({ status: "running" as const, endpointId: "endpoint-1", pid: 123 }),
        }),
      } as CloudHttpDependencies;

      yield* applyCloudRelayConfig(
        dependencies,
        {
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          cloudUserId: "current-user",
          environmentCredential: "current-credential",
          cloudMintPublicKey,
          endpointRuntime: runtimeConfig,
        },
        3_800,
      );

      expect(new TextDecoder().decode(values.get(CLOUD_MANAGED_TUNNEL_LOCAL_PORT))).toBe("3800");
      expect(yield* readCloudLinkState(dependencies)).toMatchObject({
        linked: true,
        managedTunnelActive: true,
        managedTunnelLocalPort: 3_800,
        currentLocalHttpPort: 3_800,
      });

      values.set(CLOUD_MANAGED_TUNNEL_LOCAL_PORT, encoded("not-a-port"));
      expect(yield* readCloudLinkState(dependencies)).toMatchObject({
        managedTunnelActive: true,
        managedTunnelLocalPort: null,
      });
    }),
  );
});

describe("paired remote account linking", () => {
  const principal = (overrides: Partial<EnvironmentSessionPrincipalShape> = {}) =>
    ({
      sessionId: AuthSessionId.make("paired-mobile-session"),
      subject: "paired-user",
      method: "dpop-access-token",
      scopes: new Set([AuthRelayReadScope, AuthRelayWriteScope]),
      proofKeyThumbprint: "verified-device-proof-key",
      ...overrides,
    }) satisfies EnvironmentSessionPrincipalShape;

  const request = (
    url = "http://192.168.1.50:3800/api/connect/link-proof",
    headers: Record<string, string> = {},
  ) => HttpServerRequest.fromWeb(new Request(url, { headers }));

  it.effect("uses the configured listener for an administrator paired over LAN", () =>
    Effect.gen(function* () {
      const origin = yield* authorizeCloudLinkOrigin(3_800).pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principal()),
        Effect.provideService(HttpServerRequest.HttpServerRequest, request()),
      );
      expect(origin).toEqual({ localHttpHost: "127.0.0.1", localHttpPort: 3_800 });
    }),
  );

  it.effect("never chooses a DPoP tunnel target from attacker-controlled Host or port", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://127.0.0.1:9222/api/connect/link-proof",
        "https://attacker.test:444/api/connect/link-proof",
      ]) {
        const origin = yield* authorizeCloudLinkOrigin(3_800).pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, principal()),
          Effect.provideService(HttpServerRequest.HttpServerRequest, request(url)),
        );
        expect(origin).toEqual({ localHttpHost: "127.0.0.1", localHttpPort: 3_800 });
      }
    }),
  );

  it.effect("rejects supplied origins naming other services before issuing a link proof", () =>
    Effect.gen(function* () {
      for (const origin of [
        { localHttpHost: "127.0.0.1", localHttpPort: 9_222 },
        { localHttpHost: "attacker.test", localHttpPort: 3_800 },
      ]) {
        const result = yield* Effect.result(
          authorizeCloudLinkOrigin(3_800, origin).pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, principal()),
            Effect.provideService(HttpServerRequest.HttpServerRequest, request()),
          ),
        );
        expect(result._tag).toBe("Failure");
      }
    }),
  );

  it.effect("rejects non-admin and unbound remote sessions", () =>
    Effect.gen(function* () {
      for (const actor of [
        principal({ scopes: new Set([AuthRelayReadScope]) }),
        principal({ method: "bearer-access-token", proofKeyThumbprint: "" }),
        principal({ method: "browser-session-cookie", proofKeyThumbprint: "" }),
        principal({ proofKeyThumbprint: "" }),
      ]) {
        const result = yield* Effect.result(
          authorizeCloudLinkOrigin(3_800).pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, actor),
            Effect.provideService(HttpServerRequest.HttpServerRequest, request()),
          ),
        );
        expect(result._tag).toBe("Failure");
      }
    }),
  );

  it.effect("rejects forwarded authorities and an unavailable configured listener", () =>
    Effect.gen(function* () {
      for (const header of ["x-forwarded-host", "x-forwarded-proto", "forwarded"]) {
        const result = yield* Effect.result(
          authorizeCloudLinkOrigin(3_800).pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, principal()),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              request(undefined, { [header]: "attacker.test:9222" }),
            ),
          ),
        );
        expect(result._tag).toBe("Failure");
      }
      for (const port of [undefined, 0, 65_536, 3.5]) {
        const result = yield* Effect.result(
          authorizeCloudLinkOrigin(port).pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, principal()),
            Effect.provideService(HttpServerRequest.HttpServerRequest, request()),
          ),
        );
        expect(result._tag).toBe("Failure");
      }
    }),
  );

  it.effect("preserves existing local desktop browser sessions", () =>
    authorizeCloudLinkOrigin(3_800).pipe(
      Effect.provideService(
        EnvironmentAuthenticatedPrincipal,
        principal({ method: "browser-session-cookie", proofKeyThumbprint: "" }),
      ),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request("http://localhost:3000/api/connect/link-proof"),
      ),
      Effect.map((origin) =>
        expect(origin).toEqual({ localHttpHost: "127.0.0.1", localHttpPort: 3_000 }),
      ),
    ),
  );
});
