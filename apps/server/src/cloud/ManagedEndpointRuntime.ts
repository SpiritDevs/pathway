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
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_MANAGED_TUNNEL_LOCAL_PORT,
  decodeManagedTunnelLocalPort,
  decodeRuntimeConfig,
} from "./config.ts";

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A connector config plus the local listener port the user authorized it to expose. */
export interface ManagedEndpointConnection {
  readonly config: RelayManagedEndpointRuntimeConfig;
  readonly originPort: number;
}

/** The Connect fields of a config, or null when it was issued for cloudflared. */
export function connectorTarget(config: RelayManagedEndpointRuntimeConfig) {
  return config.edgeUrl && config.endpointId
    ? { edgeUrl: config.edgeUrl, endpointId: config.endpointId }
    : null;
}

const readStoredConnection = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const config = Option.flatMap(yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG), (bytes) =>
    decodeRuntimeConfig(bytesToString(bytes)),
  );
  const originPort = Option.flatMap(yield* secrets.get(CLOUD_MANAGED_TUNNEL_LOCAL_PORT), (bytes) =>
    decodeManagedTunnelLocalPort(bytesToString(bytes)),
  );
  return Option.isSome(config) && Option.isSome(originPort)
    ? { config: config.value, originPort: originPort.value }
    : null;
});

export type CloudManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      // The config was issued for cloudflared; the relay must issue a Connect one.
      readonly status: "needs_reprovision";
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
    /** Resolves once the edge registers the connector, or with the reason it did not. */
    readonly applyConfig: (
      connection: ManagedEndpointConnection | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
  }
>()("@spiritdevs/pathway/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

export const MAX_AUTOMATIC_CONNECTOR_ATTEMPTS = 5;
export const CONNECTOR_RETRY_BACKOFF = Duration.seconds(30);
export const MAX_CONNECTOR_RETRY_BACKOFF = Duration.minutes(15);
export const CONNECTOR_REGISTRATION_TIMEOUT = Duration.seconds(15);
/** `@cyndrbase/connect` exits with code 1 only when the edge rejects the token. */
export const CONNECTOR_CREDENTIAL_REJECTED = 1;

export function connectorRetryBackoff(restartAttempt: number): Duration.Duration {
  const exponent = Math.max(0, restartAttempt - MAX_AUTOMATIC_CONNECTOR_ATTEMPTS);
  return Duration.millis(
    Math.min(
      Duration.toMillis(CONNECTOR_RETRY_BACKOFF) * 2 ** exponent,
      Duration.toMillis(MAX_CONNECTOR_RETRY_BACKOFF),
    ),
  );
}

interface ActiveConnector {
  readonly handle: RelayClient.ConnectorHandle;
  readonly configKey: string;
  readonly endpointId: string;
}

function connectionKey({ config, originPort }: ManagedEndpointConnection): string {
  return JSON.stringify([
    config.environmentId,
    config.edgeUrl,
    config.endpointId,
    config.connectorToken,
    originPort,
  ]);
}

const stopConnector = (connector: ActiveConnector | null) =>
  connector
    ? Effect.promise(() => connector.handle.stop()).pipe(
        Effect.tap(() =>
          Effect.logInfo("Relay client stopped", {
            pid: connector.handle.pid,
            endpointId: connector.endpointId,
          }),
        ),
      )
    : Effect.void;

// Registration is the connector's receipt that the edge accepted its token and endpoint.
const awaitRegistration = (handle: RelayClient.ConnectorHandle) =>
  Effect.promise(() =>
    Promise.race([
      handle.ready.then(
        () => "registered" as const,
        () => "exited" as const,
      ),
      handle.exited.then(() => "exited" as const),
    ]),
  ).pipe(
    Effect.timeoutOption(CONNECTOR_REGISTRATION_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed("The Pathway Connect edge could not be reached."),
        onSome: (outcome) =>
          outcome === "registered"
            ? Effect.succeed(null)
            : Effect.promise(() => handle.exited).pipe(
                Effect.map((exit) =>
                  exit.code === CONNECTOR_CREDENTIAL_REJECTED
                    ? "Pathway Connect rejected this environment's connector token."
                    : "The relay client exited before it registered.",
                ),
              ),
      }),
    ),
  );

export const make = Effect.gen(function* () {
  const relayClient = yield* RelayClient.RelayClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const runtimeScope = yield* Scope.Scope;
  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  const desiredRef = yield* Ref.make<ManagedEndpointConnection | null>(null);
  const restartAttemptsRef = yield* Ref.make(0);
  const reconcileSemaphore = yield* Semaphore.make(1);
  let reconcile: (
    connection: ManagedEndpointConnection | null,
    gated: boolean,
  ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    yield* stopConnector(active);
  });

  const isDesired = (configKey: string) =>
    Ref.get(desiredRef).pipe(
      Effect.map((desired) => desired !== null && connectionKey(desired) === configKey),
    );

  const restartConnectorIfDesired = Effect.fn(
    "CloudManagedEndpointRuntime.restartConnectorIfDesired",
  )(function* (configKey: string) {
    yield* reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const desired = yield* Ref.get(desiredRef);
        if (desired && (yield* isDesired(configKey))) {
          yield* reconcile(desired, false);
        }
      }),
    );
  });

  // The connector reconnects by itself, so it exits only when its token is rejected, which
  // is terminal, or when it crashes, which is retried with backoff once crashes repeat.
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
          if (exit.code === CONNECTOR_CREDENTIAL_REJECTED) {
            yield* Effect.logError(
              "Pathway Connect rejected this environment's connector token; relink to restore remote access",
              { pid: connector.handle.pid, endpointId: connector.endpointId },
            );
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
            endpointId: connector.endpointId,
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

  const observeRegistration = (connector: ActiveConnector) =>
    Effect.tryPromise(() => connector.handle.ready).pipe(
      Effect.andThen(Ref.set(restartAttemptsRef, 0)),
      Effect.andThen(
        Effect.logInfo("Relay client tunnel connection registered", {
          pid: connector.handle.pid,
          endpointId: connector.endpointId,
        }),
      ),
      Effect.ignore,
    );

  reconcile = Effect.fn("CloudManagedEndpointRuntime.reconcile")(function* (
    connection: ManagedEndpointConnection | null,
    gated: boolean,
  ) {
    if (!connection) {
      yield* stopActive;
      return { status: "disabled" } satisfies CloudManagedEndpointRuntimeStatus;
    }
    const { config, originPort } = connection;
    const target = connectorTarget(config);
    if (!target) {
      yield* stopActive;
      return { status: "needs_reprovision" } satisfies CloudManagedEndpointRuntimeStatus;
    }
    const failed = (reason: string) =>
      ({
        status: "failed",
        endpointId: target.endpointId,
        reason,
      }) satisfies CloudManagedEndpointRuntimeStatus;
    if (config.environmentId !== environmentId) {
      yield* stopActive;
      return failed(
        `Managed endpoint configuration belongs to environment ${config.environmentId}, not ${environmentId}.`,
      );
    }

    const configKey = connectionKey(connection);
    const active = yield* Ref.get(activeRef);
    if (active?.configKey === configKey) {
      return {
        status: "running",
        endpointId: target.endpointId,
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
    // Only the authorized listener is exposed, whatever host a relay-config payload names.
    const handle = yield* relayClient
      .start({
        edgeUrl: target.edgeUrl,
        endpointId: target.endpointId,
        token: config.connectorToken,
        originHost: "127.0.0.1",
        originPort,
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Failed to start relay client", {
            cause: error.cause,
            endpointId: target.endpointId,
          }),
        ),
        Effect.option,
      );
    if (Option.isNone(handle)) {
      return failed("The relay client could not start.");
    }
    const connector = {
      handle: handle.value,
      configKey,
      endpointId: target.endpointId,
    } satisfies ActiveConnector;
    yield* Effect.logInfo("Relay client process started; waiting for tunnel connection", {
      pid: connector.handle.pid,
      endpointId: target.endpointId,
    });
    if (gated) {
      const failure = yield* awaitRegistration(connector.handle);
      if (failure !== null) {
        yield* stopConnector(connector);
        return failed(failure);
      }
    }
    yield* Ref.set(activeRef, connector);
    yield* Effect.forkIn(observeRegistration(connector), runtimeScope);
    yield* Effect.forkIn(superviseConnector(connector), runtimeScope);
    return {
      status: "running",
      endpointId: target.endpointId,
      pid: connector.handle.pid ?? 0,
    } satisfies CloudManagedEndpointRuntimeStatus;
  });

  const apply = (connection: ManagedEndpointConnection | null, gated: boolean) =>
    reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.set(desiredRef, connection);
        yield* Ref.set(restartAttemptsRef, 0);
        const status = yield* reconcile(connection, gated);
        // A connection that never registered must not be restarted behind the caller's back.
        if (status.status !== "running" && status.status !== "disabled") {
          yield* Ref.set(desiredRef, null);
        }
        return status;
      }),
    );

  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig: Effect.fn("CloudManagedEndpointRuntime.applyConfig")((connection) =>
      apply(connection, true),
    ),
  });

  // Boot does not wait for the edge: the stored connector keeps reconnecting until it can.
  const stored = yield* readStoredConnection.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read managed endpoint runtime config", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );
  yield* apply(stored, false);
  yield* Effect.addFinalizer(() => apply(null, false));
  return runtime;
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
