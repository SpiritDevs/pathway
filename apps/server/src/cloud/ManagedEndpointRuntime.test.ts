import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as RelayClient from "@spiritdevs/shared/relayClient";
import { EnvironmentId } from "@spiritdevs/contracts";
import { RelayManagedEndpointRuntimeConfig } from "@spiritdevs/contracts/relay";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, CLOUD_MANAGED_TUNNEL_LOCAL_PORT } from "./config.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-test");

const config = (connectorToken = "token-1"): RelayManagedEndpointRuntimeConfig => ({
  environmentId: ENVIRONMENT_ID,
  providerKind: "pathway_relay",
  connectorToken,
  edgeUrl: "wss://edge.example.test/connect/v1",
  endpointId: "endpoint-1",
});
const connection = (connectorToken?: string) => ({
  config: config(connectorToken),
  originPort: 3773,
});

interface FakeConnector {
  readonly options: RelayClient.RelayClientStartOptions;
  readonly handle: RelayClient.ConnectorHandle;
  readonly register: () => void;
  readonly exit: (code: number) => void;
  stopped: boolean;
}

/** Started connectors register and exit only when the test (or `stop`) says so. */
const fakeRelayClient = (
  started: Array<FakeConnector>,
  options?: {
    readonly status?: RelayClient.RelayClientStatus;
    readonly registerOnStart?: boolean;
    readonly onStart?: (connector: FakeConnector) => Effect.Effect<void>;
  },
) =>
  RelayClient.RelayClient.of({
    resolve: Effect.succeed(
      options?.status ?? {
        status: "available",
        executablePath: "/bundle/cyndrbase-connector",
        source: "managed",
        version: "0.1.0",
      },
    ),
    start: (startOptions) =>
      Effect.gen(function* () {
        let exit!: (code: number) => void;
        let register!: () => void;
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            exit = (code) => resolve({ code, signal: null });
          },
        );
        const ready = new Promise<void>((resolve, reject) => {
          register = resolve;
          void exited.then(() => reject(new Error("exited")));
        });
        ready.catch(() => undefined);
        const connector: FakeConnector = {
          options: startOptions,
          register,
          exit,
          stopped: false,
          handle: {
            pid: 700 + started.length,
            ready,
            exited,
            stop: async () => {
              connector.stopped = true;
              exit(0);
              await exited;
            },
          },
        };
        started.push(connector);
        if (options?.registerOnStart ?? true) register();
        yield* options?.onStart?.(connector) ?? Effect.void;
        return connector.handle;
      }),
  });

const encodeRuntimeConfig = Schema.encodeSync(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);
const stored = (connectorToken: string) =>
  new Map([
    [CLOUD_ENDPOINT_RUNTIME_CONFIG, encodeRuntimeConfig(config(connectorToken))],
    [CLOUD_MANAGED_TUNNEL_LOCAL_PORT, "3773"],
  ]);

const buildRuntime = (
  relayClient: RelayClient.RelayClient["Service"],
  secrets: ReadonlyMap<string, string> = new Map(),
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      ManagedEndpointRuntime.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RelayClient.RelayClient, relayClient),
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: (name) =>
                Effect.succeed(
                  Option.map(Option.fromNullishOr(secrets.get(name)), (value) =>
                    new TextEncoder().encode(value),
                  ),
                ),
            }),
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
              getDescriptor: Effect.die("unused"),
            }),
          ),
        ),
      ),
    );
    return yield* Effect.service(ManagedEndpointRuntime.CloudManagedEndpointRuntime).pipe(
      Effect.provide(context),
    );
  });

describe("CloudManagedEndpointRuntime", () => {
  it("backs off exponentially and caps persistent connector retries", () => {
    expect(
      Duration.toMillis(
        ManagedEndpointRuntime.connectorRetryBackoff(
          ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS,
        ),
      ),
    ).toBe(Duration.toMillis(Duration.seconds(30)));
    expect(
      Duration.toMillis(ManagedEndpointRuntime.connectorRetryBackoff(Number.MAX_SAFE_INTEGER)),
    ).toBe(Duration.toMillis(ManagedEndpointRuntime.MAX_CONNECTOR_RETRY_BACKOFF));
  });

  it.effect("starts, deduplicates, rotates, and stops a connector on the authorized port", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const runtime = yield* buildRuntime(fakeRelayClient(started));

      const running = yield* runtime.applyConfig(connection("token-1"));
      yield* runtime.applyConfig(connection("token-1"));
      yield* runtime.applyConfig(connection("token-2"));
      const stopped = yield* runtime.applyConfig(null);

      expect(running).toEqual({ status: "running", endpointId: "endpoint-1", pid: 700 });
      expect(started.map((connector) => connector.options)).toEqual(
        ["token-1", "token-2"].map((token) => ({
          edgeUrl: "wss://edge.example.test/connect/v1",
          endpointId: "endpoint-1",
          token,
          originHost: "127.0.0.1",
          originPort: 3773,
        })),
      );
      expect(started.map((connector) => connector.stopped)).toEqual([true, true]);
      expect(stopped).toEqual({ status: "disabled" });
    }),
  );

  it.effect("asks for reprovisioning instead of running a cloudflared config", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const runtime = yield* buildRuntime(fakeRelayClient(started));

      const status = yield* runtime.applyConfig({
        config: {
          environmentId: ENVIRONMENT_ID,
          providerKind: "cloudflare_tunnel",
          connectorToken: "cloudflared-token",
        },
        originPort: 3773,
      });

      expect(status).toEqual({ status: "needs_reprovision" });
      expect(started).toEqual([]);
    }),
  );

  it.effect("refuses a connector configuration owned by another environment", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const runtime = yield* buildRuntime(fakeRelayClient(started));

      const status = yield* runtime.applyConfig({
        config: { ...config(), environmentId: EnvironmentId.make("another-environment") },
        originPort: 3773,
      });

      expect(status).toMatchObject({
        status: "failed",
        reason: expect.stringContaining("another-environment"),
      });
      expect(started).toEqual([]);
    }),
  );

  it.effect("reports a rejected token as a failure without restarting it", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const runtime = yield* buildRuntime(
        fakeRelayClient(started, {
          registerOnStart: false,
          onStart: (connector) => Effect.sync(() => connector.exit(1)),
        }),
      );

      expect(yield* runtime.applyConfig(connection())).toEqual({
        status: "failed",
        endpointId: "endpoint-1",
        reason: "Pathway Connect rejected this environment's connector token.",
      });
      expect(started).toHaveLength(1);
    }),
  );

  it.effect("reports an unreachable edge once the registration deadline passes", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const startedSignal = yield* Deferred.make<void>();
      const runtime = yield* buildRuntime(
        fakeRelayClient(started, {
          registerOnStart: false,
          onStart: () => Deferred.succeed(startedSignal, undefined).pipe(Effect.asVoid),
        }),
      );

      const applying = yield* runtime.applyConfig(connection()).pipe(Effect.forkChild);
      yield* Deferred.await(startedSignal);
      yield* TestClock.adjust(ManagedEndpointRuntime.CONNECTOR_REGISTRATION_TIMEOUT);

      expect(yield* Fiber.join(applying)).toEqual({
        status: "failed",
        endpointId: "endpoint-1",
        reason: "The Pathway Connect edge could not be reached.",
      });
      expect(started[0]?.stopped).toBe(true);
    }),
  );

  it.effect("reapplying a connector that never registered waits for it to register", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      // Boot starts the stored connector without waiting; the edge is unreachable.
      const runtime = yield* buildRuntime(
        fakeRelayClient(started, { registerOnStart: false }),
        stored("token-1"),
      );

      const applying = yield* runtime.applyConfig(connection("token-1")).pipe(Effect.forkChild);
      yield* TestClock.adjust(ManagedEndpointRuntime.CONNECTOR_REGISTRATION_TIMEOUT);

      expect(yield* Fiber.join(applying)).toMatchObject({ status: "failed" });
      // The same connector keeps trying; nothing was started or stopped.
      expect(started).toHaveLength(1);
      expect(started[0]?.stopped).toBe(false);
      started[0]!.register();
      expect(yield* runtime.applyConfig(connection("token-1"))).toMatchObject({
        status: "running",
      });
    }),
  );

  it.effect("an interrupted apply stops the connector it started", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const startedSignal = yield* Deferred.make<void>();
      const runtime = yield* buildRuntime(
        fakeRelayClient(started, {
          registerOnStart: false,
          onStart: () => Deferred.succeed(startedSignal, undefined).pipe(Effect.asVoid),
        }),
      );

      const applying = yield* runtime.applyConfig(connection()).pipe(Effect.forkChild);
      yield* Deferred.await(startedSignal);
      yield* Fiber.interrupt(applying);

      expect(started[0]?.stopped).toBe(true);
      expect(yield* runtime.applyConfig(null)).toEqual({ status: "disabled" });
      expect(started).toHaveLength(1);
    }),
  );

  it.effect("treats a later credential rejection as terminal", () => {
    let logged!: () => void;
    const rejectionLogged = new Promise<void>((resolve) => {
      logged = resolve;
    });
    const logger = Logger.make(({ message }) => {
      if (String(message).includes("rejected this environment's connector token")) logged();
    });
    return Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const runtime = yield* buildRuntime(fakeRelayClient(started));

      yield* runtime.applyConfig(connection());
      started[0]!.exit(1);
      yield* Effect.promise(() => rejectionLogged);

      expect(started).toHaveLength(1);
    }).pipe(Effect.provide(Logger.layer([logger])));
  });

  it.effect("restarts a crashed connector, backing off once crashes repeat", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const starts = yield* Effect.all(
        Array.from({ length: ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS + 1 }, () =>
          Deferred.make<void>(),
        ),
      );
      // Only the first connector registers; the restarted ones crash before registering.
      const runtime = yield* buildRuntime(
        fakeRelayClient(started, {
          registerOnStart: false,
          onStart: (connector) =>
            Effect.sync(() => {
              if (started.length === 1) connector.register();
            }).pipe(
              Effect.andThen(Deferred.succeed(starts[started.length - 1]!, undefined)),
              Effect.asVoid,
            ),
        }),
      );

      yield* runtime.applyConfig(connection());
      for (
        let index = 0;
        index + 1 < ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS;
        index++
      ) {
        started[index]!.exit(101);
        yield* Deferred.await(starts[index + 1]!);
      }
      // The supervisor awaited this exit first, so it is in its backoff once we resume.
      const last = started.at(-1)!;
      last.exit(101);
      yield* Effect.promise(() => last.handle.exited);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(29));
      expect(started).toHaveLength(ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Deferred.await(starts[ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS]!);

      expect(started).toHaveLength(ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS + 1);
    }),
  );
});
