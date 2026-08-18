import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Tracer from "effect/Tracer";
import {
  HttpClient,
  HttpClientResponse,
  HttpServerRequest,
  type HttpClientRequest,
} from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EnvironmentId } from "@spiritdevs/contracts";
import type {
  RelayCloudMintCredentialProofPayload,
  RelayValidatedConnectGrantIdentity,
} from "@spiritdevs/contracts/relay";
import { RelayClientTracer } from "@spiritdevs/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_MINT_REQUEST_TYP,
  signRelayJwt,
} from "@spiritdevs/shared/relayJwt";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfigModule from "../config.ts";
import { writeServiceState } from "../serviceLauncher.ts";
import {
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
  type ServiceUpdateRecord,
} from "./serviceProtocol.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import type { RelayLinkProofRequest } from "@spiritdevs/contracts/relay";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import {
  type CloudHttpDependencies,
  cloudMintCredentialHandler,
  consumeCloudReplayGuards,
  isSupportedLinkProviderKind,
  linkProofScopes,
  pendingServiceUpdateExists,
  reconcileDesiredCloudLink,
  releaseManagedTunnelOnShutdown,
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
      ...(includeConnectGrant ? { connectGrant } : {}),
      nonce: "mint-proof-nonce",
      scope: ["environment:connect"],
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
      expect(harness.pairingInputs[0]?.initiatingEnvironmentId).toBeUndefined();
      expect(harness.secretReads).toContain(CLOUD_LINKED_USER_ID);
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

describe("releaseManagedTunnelOnShutdown", () => {
  const cliToken: CliTokenManager.PersistedToken = {
    accessToken: "cli-access-token",
    refreshToken: "cli-refresh-token",
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };

  function makeMemorySecretStore(initial: Iterable<readonly [string, string]> = []) {
    const values = new Map<string, Uint8Array>(
      Array.from(initial, ([name, value]) => [name, new TextEncoder().encode(value)] as const),
    );
    const store: ServerSecretStore.ServerSecretStore["Service"] = {
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
    return { store, values };
  }

  interface ReleaseHarness {
    readonly store: ServerSecretStore.ServerSecretStore["Service"];
    readonly applyConfigCalls: Array<unknown>;
    readonly requests: Array<HttpClientRequest.HttpClientRequest>;
    readonly respond?: () => Response;
  }

  // Writes the launcher's durable state file into this test's baseDir with
  // the launcher's own writer; the release reads it to detect an in-flight
  // update handoff.
  const writeLauncherState = (update: ServiceUpdateRecord) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const config = yield* ServerConfigModule.ServerConfig;
      const statePath = path.join(config.baseDir, "runtime", SERVICE_STATE_FILE);
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "0.0.30",
          update,
        }),
      );
    });

  const provideReleaseHarness =
    (harness: ReleaseHarness) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, harness.store),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env_123")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Effect.provideService(
          ManagedEndpointRuntime.CloudManagedEndpointRuntime,
          ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
            applyConfig: (config) =>
              Effect.sync(() => {
                harness.applyConfigCalls.push(config);
                return {
                  status: "disabled",
                } satisfies ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus;
              }),
          }),
        ),
        Effect.provideService(
          EnvironmentAuth.EnvironmentAuth,
          EnvironmentAuth.EnvironmentAuth.of({} as EnvironmentAuth.EnvironmentAuth["Service"]),
        ),
        Effect.provideService(
          CliTokenManager.CloudCliTokenManager,
          CliTokenManager.CloudCliTokenManager.of({
            get: unusedSecretStoreOperation(),
            getExisting: Effect.succeed(Option.some(cliToken)),
            hasCredential: unusedSecretStoreOperation(),
            store: () => unusedSecretStoreOperation(),
            clear: unusedSecretStoreOperation(),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              harness.requests.push(request);
              return HttpClientResponse.fromWeb(
                request,
                (harness.respond ?? (() => Response.json({ ok: true })))(),
              );
            }),
          ),
        ),
        // The release consults the launcher state file under the configured
        // baseDir, so every harness run gets a scoped temp baseDir.
        Effect.provide(
          ServerConfigModule.layerTest("/", { prefix: "pathway-http-release-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.scoped,
      );

  // The persisted state of a CLI-managed link whose tunnel is releasable.
  const managedLinkSecrets = [
    [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
    [RELAY_URL_SECRET, "https://relay.example.test"],
    [CLOUD_CLI_DESIRED_LINK_SECRET, "managed"],
  ] as const;

  it.effect("stops the connector, releases the relay tunnel, and drops the dead token", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const released = yield* releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);
      expect(applyConfigCalls).toEqual([null]);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.method).toBe("DELETE");
      expect(request.url).toBe(
        "https://relay.example.test/v1/client/environment-links/env_123/tunnel",
      );
      expect(request.headers.authorization).toBe("Bearer cli-access-token");
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("does nothing for links without a stored managed tunnel runtime config", () => {
    const { store } = makeMemorySecretStore();
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const released = yield* releaseManagedTunnelOnShutdown();

      expect(released).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("leaves the tunnel of a web/mobile-installed link untouched", () => {
    // A managed runtime config without a CLI-desired link: the environment was
    // linked by a web/mobile client, and nothing re-provisions the tunnel on
    // the next boot, so shutdown must not release it.
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const released = yield* releaseManagedTunnelOnShutdown();

      expect(released).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("leaves the tunnel of a publish-only desired link untouched", () => {
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_CLI_DESIRED_LINK_SECRET, "publish_only"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const released = yield* releaseManagedTunnelOnShutdown();

      expect(released).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("keeps the tunnel when shutdown hands off to a pending update", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      yield* writeLauncherState({
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.31",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      });

      const released = yield* releaseManagedTunnelOnShutdown();

      // The launcher restarts a server immediately, so the tunnel is not
      // orphaned; keeping it avoids the hostname route re-propagation that
      // dominates update downtime. The stored config must survive so the
      // next boot respawns the connector against the same tunnel.
      expect(released).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("still releases a pending update when the launcher is stopping", () => {
    // `pathway service uninstall` or `systemctl stop` during the pending window:
    // the launcher writes its stop marker before signalling the child, so no
    // replacement server is coming and the tunnel must not be kept.
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      yield* writeLauncherState({
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.31",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfigModule.ServerConfig;
      yield* fs.writeFileString(path.join(config.baseDir, "runtime", SERVICE_STOP_MARKER_FILE), "");

      expect(yield* pendingServiceUpdateExists).toBe(true);
      const released = yield* releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);
      expect(requests).toHaveLength(1);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("still releases when the recorded update already settled", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      yield* writeLauncherState({
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.31",
        status: "committed",
      });

      const released = yield* releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);
      expect(requests).toHaveLength(1);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("keeps a runtime config that a fast restart replaced mid-release", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const freshConfig = new TextEncoder().encode("fresh-runtime-config");

    return Effect.gen(function* () {
      const released = yield* releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);
      // The finalizer only drops the config it released; the one written by
      // the restarted process while the DELETE was in flight stays.
      expect(values.get(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(freshConfig);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => {
          // A restarted process reconciled and stored a fresh connector config
          // while this shutdown's release request was in flight.
          values.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, freshConfig);
          return Response.json({ ok: true });
        },
      }),
    );
  });

  it.effect("keeps the stored connector token when the relay skipped the release", () => {
    // ok:false means a concurrent provision owns the recorded tunnel, so the
    // stored runtime config (possibly freshly written by that provision) must
    // survive.
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const released = yield* releaseManagedTunnelOnShutdown();

      expect(released).toBe(false);
      expect(requests).toHaveLength(1);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => Response.json({ ok: false }),
      }),
    );
  });

  it.effect("keeps the stored connector token when the relay release request fails", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const result = yield* Effect.result(releaseManagedTunnelOnShutdown());

      expect(result._tag).toBe("Failure");
      expect(requests).toHaveLength(1);
      // The tunnel still exists, so the stored token stays valid across the
      // restart and the next boot can bring the connector back immediately.
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => Response.json({ ok: false }, { status: 503 }),
      }),
    );
  });
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
});
