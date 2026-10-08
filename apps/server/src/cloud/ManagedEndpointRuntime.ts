import type { RelayManagedEndpointRuntimeConfig } from "@spiritdevs/contracts/relay";
import * as RelayClient from "@spiritdevs/shared/relayClient";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, decodeRuntimeConfig } from "./config.ts";

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const readRuntimeConfig = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const bytes = yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  if (Option.isNone(bytes)) {
    return null;
  }
  return Option.getOrNull(decodeRuntimeConfig(bytesToString(bytes.value)));
});

export type CloudManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly endpointId: string;
      readonly reason: string;
    }
  | {
      readonly status: "running";
      readonly endpointId: string;
      readonly pid: number;
    };

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
  }
>()("@spiritdevs/pathway/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

export const MAX_AUTOMATIC_CONNECTOR_ATTEMPTS = 5;
export const CONNECTOR_RETRY_BACKOFF = Duration.seconds(30);
export const MAX_CONNECTOR_RETRY_BACKOFF = Duration.minutes(15);

export function connectorRetryBackoff(restartAttempt: number): Duration.Duration {
  const exponent = Math.max(0, restartAttempt - MAX_AUTOMATIC_CONNECTOR_ATTEMPTS);
  return Duration.millis(
    Math.min(
      Duration.toMillis(CONNECTOR_RETRY_BACKOFF) * 2 ** exponent,
      Duration.toMillis(MAX_CONNECTOR_RETRY_BACKOFF),
    ),
  );
}

// The connector dials an IP address; links made against "localhost" use IPv4 loopback.
export function connectorOriginHost(host: string): string {
  const bare = host.replace(/^\[(.*)\]$/u, "$1");
  return bare === "localhost" ? "127.0.0.1" : bare;
}

interface ActiveConnector {
  readonly handle: RelayClient.ConnectorHandle;
  readonly configKey: string;
  readonly config: RelayManagedEndpointRuntimeConfig;
}

function runtimeConfigKey(config: RelayManagedEndpointRuntimeConfig): string {
  return JSON.stringify([
    config.environmentId,
    config.edgeUrl,
    config.endpointId,
    config.connectorToken,
    config.origin.localHttpHost,
    config.origin.localHttpPort,
  ]);
}

const stopConnector = (connector: ActiveConnector | null) =>
  connector
    ? Effect.promise(() => connector.handle.stop()).pipe(
        Effect.tap(() =>
          Effect.logInfo("Relay client stopped", {
            pid: connector.handle.pid,
            endpointId: connector.config.endpointId,
          }),
        ),
      )
    : Effect.void;

export const make = Effect.gen(function* () {
  const relayClient = yield* RelayClient.RelayClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const runtimeScope = yield* Scope.Scope;
  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  const desiredConfigRef = yield* Ref.make<RelayManagedEndpointRuntimeConfig | null>(null);
  const restartAttemptsRef = yield* Ref.make(0);
  const reconcileSemaphore = yield* Semaphore.make(1);
  let reconcileConfig: CloudManagedEndpointRuntime["Service"]["applyConfig"];

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    yield* stopConnector(active);
  });

  const isDesired = (configKey: string) =>
    Ref.get(desiredConfigRef).pipe(
      Effect.map((desired) => desired !== null && runtimeConfigKey(desired) === configKey),
    );

  const restartConnectorIfDesired = Effect.fn(
    "CloudManagedEndpointRuntime.restartConnectorIfDesired",
  )(function* (configKey: string) {
    yield* reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const desiredConfig = yield* Ref.get(desiredConfigRef);
        if (desiredConfig && (yield* isDesired(configKey))) {
          yield* reconcileConfig(desiredConfig);
        }
      }),
    );
  });

  // The connector reconnects by itself and exits only when its token is rejected or it
  // crashes, so every exit of the desired connector is retried, with backoff once repeated.
  const superviseConnector = (connector: ActiveConnector) =>
    Effect.gen(function* () {
      const exit = yield* Effect.promise(() => connector.handle.exited);
      const retryBackoff = yield* reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const active = yield* Ref.get(activeRef);
          if (active?.handle !== connector.handle) {
            return null;
          }
          yield* Ref.set(activeRef, null);
          if (!(yield* isDesired(connector.configKey))) {
            return null;
          }
          const restartAttempt = yield* Ref.updateAndGet(
            restartAttemptsRef,
            (attempts) => attempts + 1,
          );
          const retryBackoff =
            restartAttempt >= MAX_AUTOMATIC_CONNECTOR_ATTEMPTS
              ? connectorRetryBackoff(restartAttempt)
              : Duration.zero;
          yield* Effect.logWarning("Relay client exited; restarting", {
            pid: connector.handle.pid,
            exitCode: exit.code,
            signal: exit.signal,
            restartAttempt,
            retryBackoffMillis: Duration.toMillis(retryBackoff),
            endpointId: connector.config.endpointId,
          });
          return retryBackoff;
        }),
      );
      if (retryBackoff === null) return;
      if (!Duration.isZero(retryBackoff)) {
        yield* Effect.sleep(retryBackoff);
      }
      yield* restartConnectorIfDesired(connector.configKey);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Relay client supervisor failed", { cause })),
    );

  // Registration is the connector's receipt that the edge accepted its token and endpoint.
  const observeRegistration = (connector: ActiveConnector) =>
    Effect.tryPromise(() => connector.handle.ready).pipe(
      Effect.andThen(Ref.set(restartAttemptsRef, 0)),
      Effect.andThen(
        Effect.logInfo("Relay client tunnel connection registered", {
          pid: connector.handle.pid,
          endpointId: connector.config.endpointId,
        }),
      ),
      Effect.ignore,
    );

  reconcileConfig = Effect.fn("CloudManagedEndpointRuntime.reconcileConfig")(function* (config) {
    if (!config) {
      yield* stopActive;
      return { status: "disabled" } satisfies CloudManagedEndpointRuntimeStatus;
    }
    const failed = (reason: string) =>
      ({
        status: "failed",
        endpointId: config.endpointId,
        reason,
      }) satisfies CloudManagedEndpointRuntimeStatus;
    if (config.environmentId !== environmentId) {
      yield* stopActive;
      return failed(
        `Managed endpoint configuration belongs to environment ${config.environmentId}, not ${environmentId}.`,
      );
    }

    const configKey = runtimeConfigKey(config);
    const active = yield* Ref.get(activeRef);
    if (active?.configKey === configKey) {
      return {
        status: "running",
        endpointId: config.endpointId,
        pid: active.handle.pid ?? 0,
      } satisfies CloudManagedEndpointRuntimeStatus;
    }
    yield* stopActive;

    const executable = yield* relayClient.resolve;
    if (executable.status !== "available") {
      return failed(
        executable.status === "unsupported"
          ? `This Pathway build has no relay client for ${executable.platform}-${executable.arch}.`
          : "The relay client is not installed.",
      );
    }
    const handle = yield* relayClient
      .start({
        edgeUrl: config.edgeUrl,
        endpointId: config.endpointId,
        token: config.connectorToken,
        originHost: connectorOriginHost(config.origin.localHttpHost),
        originPort: config.origin.localHttpPort,
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Failed to start relay client", {
            cause: error.cause,
            endpointId: config.endpointId,
          }),
        ),
        Effect.option,
      );
    if (Option.isNone(handle)) {
      return failed("The relay client could not start.");
    }
    const connector = { handle: handle.value, configKey, config } satisfies ActiveConnector;
    yield* Ref.set(activeRef, connector);
    yield* Effect.logInfo("Relay client process started; waiting for tunnel connection", {
      pid: connector.handle.pid,
      endpointId: config.endpointId,
    });
    yield* Effect.forkIn(observeRegistration(connector), runtimeScope);
    yield* Effect.forkIn(superviseConnector(connector), runtimeScope);
    return {
      status: "running",
      endpointId: config.endpointId,
      pid: connector.handle.pid ?? 0,
    } satisfies CloudManagedEndpointRuntimeStatus;
  });

  const applyConfig = Effect.fn("CloudManagedEndpointRuntime.applyConfig")(
    (config: RelayManagedEndpointRuntimeConfig | null) =>
      reconcileSemaphore.withPermits(1)(
        Ref.set(desiredConfigRef, config).pipe(
          Effect.andThen(Ref.set(restartAttemptsRef, 0)),
          Effect.andThen(reconcileConfig(config)),
        ),
      ),
  );

  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig,
  });

  const initialConfig = yield* readRuntimeConfig.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read managed endpoint runtime config", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );
  yield* runtime.applyConfig(initialConfig);
  yield* Effect.addFinalizer(() => runtime.applyConfig(null));
  return runtime;
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
