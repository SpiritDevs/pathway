import {
  type DesktopBridge,
  EnvironmentId,
  type RelayClientInstallProgressEvent,
  type RelayClientStatus,
  WS_METHODS,
} from "@spiritdevs/contracts";
import { RelayWebClientId } from "@spiritdevs/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "@spiritdevs/client-runtime/connection";
import { type RpcSession } from "@spiritdevs/client-runtime/rpc";
import { EnvironmentRegistry } from "@spiritdevs/client-runtime/connection";
import { ManagedRelay } from "@spiritdevs/client-runtime/relay";
import { remoteHttpClientLayer } from "@spiritdevs/client-runtime/rpc";
import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";

import {
  collectCloudLinkTargets,
  linkPrimaryEnvironmentToCloud,
  listManagedCloudEnvironments,
  normalizeRelayBaseUrl,
  readPrimaryCloudLinkState,
  type CloudLinkTarget,
  unlinkPrimaryEnvironmentFromCloud,
  unlinkRelayEnvironmentFromAccount,
  updatePrimaryCloudPreferences,
} from "./linkEnvironment";

const TARGET: CloudLinkTarget = {
  environmentId: "environment-1",
  label: "Desktop",
  httpBaseUrl: "http://127.0.0.1:3000",
  wsBaseUrl: "ws://127.0.0.1:3000",
};

const createProof = vi.fn(() => Effect.succeed("dpop-proof"));
const dpopSignerLayer = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint"),
    createProof,
  }),
);

function relayLayer() {
  const http = remoteHttpClientLayer(globalThis.fetch);
  return Layer.mergeAll(
    http,
    ManagedRelay.layer({
      relayUrl: "https://relay.example.test",
      clientId: RelayWebClientId,
    }).pipe(Layer.provideMerge(dpopSignerLayer), Layer.provide(http)),
  );
}

function registryLayer(options?: {
  readonly status?: RelayClientStatus;
  readonly installEvents?: ReadonlyArray<RelayClientInstallProgressEvent>;
}) {
  return Layer.effect(
    EnvironmentRegistry,
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed(
            options?.status ?? {
              status: "available",
              executablePath: "/tmp/pathway-relay",
              source: "managed",
              version: "2026.6.0",
            },
          ),
        [WS_METHODS.cloudInstallRelayClient]: () =>
          Stream.fromIterable(options?.installEvents ?? []),
      } as unknown as RpcSession["client"];
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(TARGET.environmentId),
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        wsBaseUrl: TARGET.wsBaseUrl,
      });
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor["Service"]);
      const registry = {
        run: <A, E, R>(_environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        runStream: <A, E, R>(_environmentId: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as unknown as EnvironmentRegistry["Service"];
      return EnvironmentRegistry.of(registry);
    }),
  );
}

function services(options?: Parameters<typeof registryLayer>[0]) {
  return Layer.mergeAll(relayLayer(), registryLayer(options));
}

function withServices<A, E>(
  effect: Effect.Effect<
    A,
    E,
    HttpClient.HttpClient | ManagedRelay.ManagedRelayClient | EnvironmentRegistry
  >,
  options?: Parameters<typeof registryLayer>[0],
) {
  return effect.pipe(Effect.provide(services(options)));
}

function bodyText(body: BodyInit | null | undefined): string {
  return body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_PATHWAY_RELAY_URL", "https://relay.example.test");
});

afterEach(() => {
  __resetDesktopPrimaryAuthForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("web cloud link environment client", () => {
  it("normalizes relay URLs and de-duplicates cloud link targets", () => {
    expect(normalizeRelayBaseUrl(" https://relay.example.test/// ")).toBe(
      "https://relay.example.test",
    );
    expect(normalizeRelayBaseUrl(" ")).toBeNull();
    expect(
      collectCloudLinkTargets({
        primary: TARGET,
        saved: [TARGET, { ...TARGET, environmentId: "environment-2" }],
      }).map((target) => target.environmentId),
    ).toEqual(["environment-1", "environment-2"]);
  });

  it.effect("lists relay-managed environments through the typed relay client", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          environments: [
            {
              environmentId: "environment-1",
              label: "Desktop",
              endpoint: {
                httpBaseUrl: "https://desktop.example.test",
                wsBaseUrl: "wss://desktop.example.test",
                providerKind: "cloudflare_tunnel",
              },
              linkedAt: "2026-06-06T00:00:00.000Z",
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const environments = yield* withServices(
        listManagedCloudEnvironments({ clerkToken: "clerk-token" }),
      );

      expect(environments).toHaveLength(1);
      expect(fetchMock.mock.calls[0]?.[1]?.headers.authorization).toBe("Bearer clerk-token");
    }),
  );

  it.effect("unlinks an account environment without contacting the local server", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        unlinkRelayEnvironmentFromAccount({
          clerkToken: "clerk-token",
          environmentId: EnvironmentId.make(TARGET.environmentId),
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        `/v1/client/environment-links/${TARGET.environmentId}`,
      );
    }),
  );

  it.effect("accepts a teardown error when the account link was already revoked", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              _tag: "RelayInternalError",
              code: "internal_error",
              reason: "upstream_unavailable",
              traceId: "trace-unlink-teardown",
            },
            { status: 500 },
          ),
        )
        .mockResolvedValueOnce(Response.json({ environments: [] }));
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        unlinkRelayEnvironmentFromAccount({
          clerkToken: "clerk-token",
          environmentId: EnvironmentId.make(TARGET.environmentId),
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("keeps an unlink error when the account still owns the environment", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              _tag: "RelayInternalError",
              code: "internal_error",
              reason: "persistence_failed",
              traceId: "trace-unlink-persistence",
            },
            { status: 500 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({
            environments: [
              {
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                endpoint: {
                  httpBaseUrl: "https://desktop.example.test",
                  wsBaseUrl: "wss://desktop.example.test",
                  providerKind: "cloudflare_tunnel",
                },
                linkedAt: "2026-06-06T00:00:00.000Z",
              },
            ],
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const error = yield* withServices(
        unlinkRelayEnvironmentFromAccount({
          clerkToken: "clerk-token",
          environmentId: EnvironmentId.make(TARGET.environmentId),
        }),
      ).pipe(Effect.flip);

      expect(error.message).toBe(
        "Could not remove the environment from Pathway Connect; the account still lists it.",
      );
      expect(error.traceId).toBe("trace-unlink-persistence");
      expect(error.diagnostic).toMatchObject({
        unlink: {
          tag: "ManagedRelayRequestFailedError",
          traceId: "trace-unlink-persistence",
          relayError: {
            tag: "RelayInternalError",
            code: "internal_error",
            reason: "persistence_failed",
            traceId: "trace-unlink-persistence",
          },
        },
        listing: {
          result: "success",
          environmentStillPresent: true,
          environmentCount: 1,
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("reads primary cloud link state from the explicit target", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: false,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const state = yield* withServices(readPrimaryCloudLinkState({ target: TARGET }));

      expect(Option.fromNullishOr(state)).toEqual(
        Option.some({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: false,
        }),
      );
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/link-state",
      );
    }),
  );

  it.effect("uses desktop bearer auth for primary cloud link state", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: false,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("window", {
        location: { origin: "pathway://app" },
        desktopBridge: {
          getLocalEnvironmentBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
        } as unknown as DesktopBridge,
      });

      yield* withServices(readPrimaryCloudLinkState({ target: TARGET }));

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }),
  );

  it.effect("updates agent activity publishing for the explicit primary target", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: true,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const state = yield* withServices(
        updatePrimaryCloudPreferences({
          target: TARGET,
          publishAgentActivity: true,
        }),
      );

      expect(state.publishAgentActivity).toBe(true);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/preferences",
      );
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(bodyText(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        publishAgentActivity: true,
      });
    }),
  );

  it.effect("links an available primary environment without invoking installation", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            challenge: "challenge",
            expiresAt: "2026-06-06T00:05:00.000Z",
          }),
        )
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: "https://desktop.example.test",
              wsBaseUrl: "wss://desktop.example.test",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "configured" } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
      );

      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/link-proof",
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(bodyText(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
        challenge: "challenge",
        endpoint: {
          httpBaseUrl: TARGET.httpBaseUrl,
          wsBaseUrl: TARGET.wsBaseUrl,
        },
      });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(bodyText(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
        deviceId: TARGET.environmentId,
        proof: "signed-proof",
      });
    }),
  );

  it.effect("links publish-only without a managed tunnel", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            challenge: "challenge",
            expiresAt: "2026-06-06T00:05:00.000Z",
          }),
        )
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: TARGET.httpBaseUrl,
              wsBaseUrl: TARGET.wsBaseUrl,
              providerKind: "manual",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
          mode: "publish_only",
        }),
      );

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(bodyText(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        managedTunnelsEnabled: false,
      });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(bodyText(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
        endpoint: { providerKind: "manual" },
      });
    }),
  );

  it.effect("installs a missing relay client before linking", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ malformed: true })));

      const error = yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
        {
          status: { status: "missing", version: "2026.6.0" },
          installEvents: [
            { type: "progress", stage: "downloading" },
            {
              type: "complete",
              status: {
                status: "available",
                executablePath: "/tmp/pathway-relay",
                source: "managed",
                version: "2026.6.0",
              },
            },
          ],
        },
      ).pipe(Effect.flip);

      expect(error.message).toContain("environment-link-challenges failed");
      expect(error.message).not.toContain("relay client install");
    }),
  );

  it.effect("rolls back the relay link when the environment is bound to another account", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            challenge: "challenge",
            expiresAt: "2026-06-06T00:05:00.000Z",
          }),
        )
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: "https://desktop.example.test",
              wsBaseUrl: "wss://desktop.example.test",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json(
            {
              _tag: "EnvironmentHttpConflictError",
              message:
                "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
            },
            { status: 409 },
          ),
        )
        .mockResolvedValueOnce(Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      const error = yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);

      expect(error.message).toContain("already linked to a different cloud account");
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(String(fetchMock.mock.calls[4]?.[0])).toContain(
        `/v1/client/environment-links/${TARGET.environmentId}`,
      );
      expect(fetchMock.mock.calls[4]?.[1]?.method).toBe("DELETE");
    }),
  );

  it.effect("keeps the relay link when the environment fails for another reason", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            challenge: "challenge",
            expiresAt: "2026-06-06T00:05:00.000Z",
          }),
        )
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: "https://desktop.example.test",
              wsBaseUrl: "wss://desktop.example.test",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json(
            {
              _tag: "EnvironmentHttpInternalServerError",
              message: "Could not persist environment relay configuration.",
            },
            { status: 500 },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);

      expect(fetchMock).toHaveBeenCalledTimes(4);
    }),
  );

  it.effect("unlinks locally before revoking the relay record", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
        )
        .mockResolvedValueOnce(Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        unlinkPrimaryEnvironmentFromCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
      );

      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3000/api/connect/unlink");
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
        `/v1/client/environment-links/${TARGET.environmentId}`,
      );
    }),
  );
});
