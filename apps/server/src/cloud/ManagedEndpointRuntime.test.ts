import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as RelayClient from "@spiritdevs/shared/relayClient";
import { EnvironmentId } from "@spiritdevs/contracts";
import type { RelayManagedEndpointRuntimeConfig } from "@spiritdevs/contracts/relay";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-test");

const config = (connectorToken = "token-1"): RelayManagedEndpointRuntimeConfig => ({
  environmentId: ENVIRONMENT_ID,
  edgeUrl: "wss://edge.example.test/connect/v1",
  endpointId: "endpoint-1",
  connectorToken,
  origin: { localHttpHost: "localhost", localHttpPort: 3773 },
});

interface FakeConnector {
  readonly options: RelayClient.RelayClientStartOptions;
  readonly handle: RelayClient.ConnectorHandle;
  readonly exit: () => void;
  stopped: boolean;
}

/** Each started connector exits only when the test (or `stop`) says so. */
const fakeRelayClient = (
  started: Array<FakeConnector>,
  options?: {
    readonly status?: RelayClient.RelayClientStatus;
    readonly onStart?: (index: number) => Effect.Effect<void>;
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
        let exit!: () => void;
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            exit = () => resolve({ code: 1, signal: null });
          },
        );
        const connector: FakeConnector = {
          options: startOptions,
          exit,
          stopped: false,
          handle: {
            pid: 700 + started.length,
            ready: exited.then(() => Promise.reject(new Error("exited"))),
            exited,
            stop: async () => {
              connector.stopped = true;
              exit();
              await exited;
            },
          },
        };
        connector.handle.ready.catch(() => undefined);
        started.push(connector);
        yield* options?.onStart?.(started.length - 1) ?? Effect.void;
        return connector.handle;
      }),
  });

const buildRuntime = (relayClient: RelayClient.RelayClient["Service"]) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      ManagedEndpointRuntime.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RelayClient.RelayClient, relayClient),
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () => Effect.succeed(Option.none()),
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
      Duration.toMillis(
        ManagedEndpointRuntime.connectorRetryBackoff(
          ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS + 2,
        ),
      ),
    ).toBe(Duration.toMillis(Duration.minutes(2)));
    expect(
      Duration.toMillis(ManagedEndpointRuntime.connectorRetryBackoff(Number.MAX_SAFE_INTEGER)),
    ).toBe(Duration.toMillis(ManagedEndpointRuntime.MAX_CONNECTOR_RETRY_BACKOFF));
  });

  it("dials loopback origins by IP address", () => {
    expect(ManagedEndpointRuntime.connectorOriginHost("localhost")).toBe("127.0.0.1");
    expect(ManagedEndpointRuntime.connectorOriginHost("[::1]")).toBe("::1");
    expect(ManagedEndpointRuntime.connectorOriginHost("127.0.0.1")).toBe("127.0.0.1");
  });

  it.effect("starts, deduplicates, rotates, and stops the connector", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const runtime = yield* buildRuntime(fakeRelayClient(started));

      const running = yield* runtime.applyConfig(config("token-1"));
      yield* runtime.applyConfig(config("token-1"));
      yield* runtime.applyConfig(config("token-2"));
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

  it.effect("refuses a connector configuration owned by another environment", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const runtime = yield* buildRuntime(fakeRelayClient(started));

      const status = yield* runtime.applyConfig({
        ...config(),
        environmentId: EnvironmentId.make("another-environment"),
      });

      expect(status).toMatchObject({
        status: "failed",
        reason: expect.stringContaining("another-environment"),
      });
      expect(started).toEqual([]);
    }),
  );

  it.effect("reports a build without a connector for this platform", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const runtime = yield* buildRuntime(
        fakeRelayClient(started, {
          status: { status: "unsupported", platform: "freebsd", arch: "x64", version: "0.1.0" },
        }),
      );

      expect(yield* runtime.applyConfig(config())).toEqual({
        status: "failed",
        endpointId: "endpoint-1",
        reason: "This Pathway build has no relay client for freebsd-x64.",
      });
      expect(started).toEqual([]);
    }),
  );

  it.effect("restarts an exited connector, backing off once exits repeat", () =>
    Effect.gen(function* () {
      const started: Array<FakeConnector> = [];
      const starts = yield* Effect.all(
        Array.from({ length: ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS + 1 }, () =>
          Deferred.make<void>(),
        ),
      );
      const runtime = yield* buildRuntime(
        fakeRelayClient(started, {
          onStart: (index) => Deferred.succeed(starts[index]!, undefined).pipe(Effect.asVoid),
        }),
      );

      yield* runtime.applyConfig(config());
      for (
        let index = 0;
        index + 1 < ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS;
        index++
      ) {
        started[index]!.exit();
        yield* Deferred.await(starts[index + 1]!);
      }
      // The supervisor awaited this exit first, so it is in its backoff once we resume.
      const last = started.at(-1)!;
      last.exit();
      yield* Effect.promise(() => last.handle.exited);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(29));
      expect(started).toHaveLength(ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Deferred.await(starts[ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS]!);

      expect(started).toHaveLength(ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS + 1);
      expect(started.slice(0, -1).every((connector) => !connector.stopped)).toBe(true);
    }),
  );
});
