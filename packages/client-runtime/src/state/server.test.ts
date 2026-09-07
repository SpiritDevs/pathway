import {
  EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Socket from "effect/unstable/socket/Socket";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyServerConfigProjection,
  createServerEnvironmentAtoms,
  makeEnvironmentServerConfigState,
  isLegacyUpdateHandoffLoss,
  isDesktopUpdateHandoffLoss,
  matchesServerUpdateReadyEvent,
  matchesServerUpdateResumeEvent,
  nudgeReconnectDuringUpdateRestart,
  projectServerWelcome,
  resolveServerConfigValue,
  resolveServerUpdateProgressResult,
  serverUpdateStateForProgressEvent,
  serverUpdateStateForServerVersion,
  validateServerUpdateReadyEvent,
  waitForDesktopUpdateTarget,
  waitForNextEnvironmentReconnect,
  runDesktopCommitWithReconnectObserver,
  withProviderUsageLegacyFallback,
} from "./server.ts";

const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
} as unknown as ServerConfig;

const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);

const snapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(CONFIG),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("update restart reconnect nudges", () => {
  it.effect("bounds a missing-session commit when the environment never reconnects", () =>
    Effect.gen(function* () {
      const committed = yield* Deferred.make<void>();
      const states = yield* SubscriptionRef.make({ phase: "backoff" });
      const unavailable = new EnvironmentRpcUnavailableError({
        environmentId: TARGET.environmentId,
        message: "The environment is not connected.",
      });
      const retry = yield* runDesktopCommitWithReconnectObserver(
        SubscriptionRef.changes(states),
        Deferred.succeed(committed, undefined).pipe(Effect.andThen(Effect.fail(unavailable))),
      ).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(committed);
      yield* TestClock.adjust(Duration.minutes(4));
      expect(yield* Fiber.join(retry)).toMatchObject({ _tag: "TimeoutError" });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it("keeps unavailable-session recovery specific to desktop commits", () => {
    const unavailable = Cause.fail(
      new EnvironmentRpcUnavailableError({
        environmentId: TARGET.environmentId,
        message: "The environment is not connected.",
      }),
    );
    expect(isDesktopUpdateHandoffLoss(unavailable)).toBe(true);
    expect(isLegacyUpdateHandoffLoss(unavailable)).toBe(false);
    expect(isDesktopUpdateHandoffLoss(Cause.fail(new Error("Access denied.")))).toBe(false);
    expect(isDesktopUpdateHandoffLoss(Cause.fail(new Error("The prepared update expired.")))).toBe(
      false,
    );
  });

  it.effect("retains the prepared token when the session drops before the initial commit", () =>
    Effect.gen(function* () {
      const prepared = {
        method: "desktop-app" as const,
        targetVersion: "0.0.34",
        desktopUpdateToken: "prepared-token",
      };
      const initialConfig = {
        ...CONFIG,
        environment: {
          serverVersion: "0.0.30",
          capabilities: {
            serverSelfUpdate: "desktop-managed",
            serverSelfUpdateProgress: true,
            desktopAppUpdate: true,
          },
        },
      } as ServerConfig;
      const states = yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected" as const,
      });
      const sessions = yield* SubscriptionRef.make(Option.none<RpcSession>());
      const preparations = yield* Ref.make(0);
      const commits = yield* Ref.make<ReadonlyArray<string>>([]);
      const unavailableCommits = yield* Ref.make(0);
      const disconnect = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });
      const makeClient = (serverVersion: string): WsRpcProtocolClient =>
        ({
          [WS_METHODS.subscribeServerConfig]: () => Stream.never,
          [WS_METHODS.subscribeServerLifecycle]: () =>
            Stream.make({
              version: 1,
              sequence: 1,
              type: "ready",
              payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion } },
            }),
          [WS_METHODS.serverUpdateServerWithProgress]: () =>
            Stream.concat(
              Stream.fromEffect(Ref.update(preparations, (count) => count + 1)).pipe(Stream.drain),
              Stream.concat(
                Stream.make({ type: "complete", result: prepared }),
                Stream.fromEffect(
                  Effect.gen(function* () {
                    yield* SubscriptionRef.set(sessions, Option.none());
                    yield* SubscriptionRef.update(states, (state) => ({
                      ...state,
                      phase: "backoff" as const,
                    }));
                  }),
                ).pipe(Stream.drain),
              ),
            ),
          [WS_METHODS.serverCommitDesktopUpdate]: ({ requestId }: { requestId: string }) =>
            Effect.gen(function* () {
              yield* Ref.update(commits, (values) => [...values, requestId]);
              yield* SubscriptionRef.update(states, (state) => ({
                ...state,
                phase: "backoff" as const,
              }));
              yield* SubscriptionRef.set(
                sessions,
                Option.some(session(makeClient(prepared.targetVersion))),
              );
              yield* SubscriptionRef.update(states, (state) => ({
                ...state,
                phase: "connected" as const,
              }));
              return yield* disconnect;
            }),
        }) as unknown as WsRpcProtocolClient;
      const oldSession = session(makeClient(initialConfig.environment.serverVersion));
      yield* SubscriptionRef.set(sessions, Option.some(oldSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: states,
        session: sessions,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environmentRegistry = EnvironmentRegistry.of({
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map(),
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        start: Effect.void,
        register: () => Effect.void,
        registerPlatform: () => Effect.void,
        reconcilePlatform: () => Effect.void,
        remove: () => Effect.void,
        removeRelayEnvironments: () => Effect.void,
        retryNow: () => Effect.void,
        disconnectNow: () => Effect.void,
        state: () => SubscriptionRef.get(states),
        stateChanges: () => SubscriptionRef.changes(states),
        run: (_environmentId, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisor,
          ).pipe(
            Effect.tapError((error) =>
              isEnvironmentRpcUnavailableError(error)
                ? Effect.gen(function* () {
                    yield* Ref.update(unavailableCommits, (count) => count + 1);
                    yield* SubscriptionRef.set(sessions, Option.some(oldSession));
                    yield* SubscriptionRef.update(states, (state) => ({
                      ...state,
                      phase: "connected" as const,
                    }));
                  })
                : Effect.void,
            ),
          ),
        runStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      });
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry, environmentRegistry),
          Layer.succeed(Persistence.EnvironmentCacheStore, cache),
        ),
      );
      const atoms = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make(initialConfig),
      });
      const atomRegistry = AtomRegistry.make();
      const result = yield* Effect.promise(() =>
        atoms.updateServer.run(atomRegistry, {
          environmentId: TARGET.environmentId,
          input: { targetVersion: "0.0.31" },
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => atomRegistry.dispose())));
      expect(result).toMatchObject({ _tag: "Success", value: prepared });
      expect(yield* Ref.get(preparations)).toBe(1);
      expect(yield* Ref.get(unavailableCommits)).toBe(1);
      expect(yield* Ref.get(commits)).toEqual([prepared.desktopUpdateToken]);
    }),
  );
  it.effect("retries a desktop commit that was lost before delivery", () =>
    Effect.gen(function* () {
      const readyEvents =
        yield* Queue.unbounded<Parameters<typeof matchesServerUpdateReadyEvent>[1]>();
      const ready = (serverVersion: string) =>
        ({
          version: 1 as const,
          sequence: 1,
          type: "ready" as const,
          payload: {
            at: "2026-09-01T00:00:00.000Z",
            environment: { serverVersion },
          },
        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
      yield* Queue.offerAll(readyEvents, [ready("0.0.30"), ready("0.0.31")]);
      const retries = yield* Ref.make(0);
      const disconnect = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });

      const result = yield* waitForDesktopUpdateTarget(
        "0.0.31",
        Queue.take(readyEvents),
        Ref.update(retries, (count) => count + 1).pipe(Effect.andThen(Effect.fail(disconnect))),
      );

      expect(result.payload.environment.serverVersion).toBe("0.0.31");
      expect(yield* Ref.get(retries)).toBe(1);
    }),
  );
  it.effect("bounds commit retries when the desktop keeps resuming on the old version", () =>
    Effect.gen(function* () {
      const ready = {
        type: "ready",
        version: 1,
        sequence: 1,
        payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion: "0.0.30" } },
      } as Parameters<typeof matchesServerUpdateReadyEvent>[1];
      const retries = yield* Ref.make(0);
      const disconnect = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });
      const failure = yield* waitForDesktopUpdateTarget(
        "0.0.31",
        Effect.succeed(ready),
        Ref.update(retries, (count) => count + 1).pipe(Effect.andThen(Effect.fail(disconnect))),
      ).pipe(Effect.flip);
      expect(failure.message).toBe(
        "The desktop app resumed without installing the prepared update.",
      );
      expect(yield* Ref.get(retries)).toBe(2);
    }),
  );

  it.effect("surfaces a rejected desktop commit without another retry", () =>
    Effect.gen(function* () {
      const ready = {
        type: "ready",
        version: 1,
        sequence: 1,
        payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion: "0.0.30" } },
      } as Parameters<typeof matchesServerUpdateReadyEvent>[1];
      const rejection = new Error("The prepared update expired.");
      const failure = yield* waitForDesktopUpdateTarget(
        "0.0.31",
        Effect.succeed(ready),
        Effect.fail(rejection),
      ).pipe(Effect.flip);
      expect(failure).toBe(rejection);
    }),
  );

  it.effect("observes a fast reconnect even when the caller awaits it later", () =>
    Effect.gen(function* () {
      const states = yield* Queue.unbounded<{ readonly phase: string }>();
      const reconnected = yield* waitForNextEnvironmentReconnect(Stream.fromQueue(states)).pipe(
        Effect.forkChild,
      );
      yield* Queue.offerAll(states, [
        { phase: "connected" },
        { phase: "backoff" },
        { phase: "connected" },
      ]);

      yield* Fiber.join(reconnected);
    }),
  );
  it.effect("arms the retry observer before a commit can disconnect", () =>
    Effect.gen(function* () {
      const allowSubscription = yield* Deferred.make<void>();
      const subscriptionStarted = yield* Deferred.make<void>();
      const states = yield* Queue.unbounded<{ readonly phase: string }>();
      const commits = yield* Ref.make(0);
      const disconnect = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });
      const stateChanges = Stream.unwrap(
        Deferred.succeed(subscriptionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowSubscription)),
          Effect.as(Stream.fromQueue(states)),
        ),
      );
      const retry = yield* runDesktopCommitWithReconnectObserver(
        stateChanges,
        Ref.update(commits, (count) => count + 1).pipe(
          Effect.andThen(Queue.offerAll(states, [{ phase: "backoff" }, { phase: "connected" }])),
          Effect.andThen(Effect.fail(disconnect)),
        ),
      ).pipe(Effect.flip, Effect.forkChild);

      yield* Deferred.await(subscriptionStarted);
      expect(yield* Ref.get(commits)).toBe(0);
      yield* Deferred.succeed(allowSubscription, undefined);
      yield* Queue.offer(states, { phase: "connected" });

      expect(yield* Fiber.join(retry)).toBe(disconnect);
      expect(yield* Ref.get(commits)).toBe(1);
    }),
  );
  it.effect("retries once per backoff entry instead of only the first", () =>
    Effect.gen(function* () {
      const retries = yield* Ref.make(0);
      const states = [
        { phase: "backoff" },
        { phase: "connecting" },
        { phase: "backoff" },
        { phase: "backoff" },
      ];

      yield* nudgeReconnectDuringUpdateRestart({
        stateChanges: Stream.fromIterable(states),
        retryNow: Ref.update(retries, (count) => count + 1),
        interval: Duration.zero,
      });

      // Three backoff entries, three nudges. The old one-shot behavior fired
      // once and then let the supervisor's ladder stretch to 16-second gaps.
      expect(yield* Ref.get(retries)).toBe(3);
    }),
  );

  it.effect("paces nudges so a fast-failing connection cannot spin", () =>
    Effect.gen(function* () {
      const retries = yield* Ref.make(0);

      const fiber = yield* Effect.forkChild(
        nudgeReconnectDuringUpdateRestart({
          stateChanges: Stream.fromIterable([{ phase: "backoff" }, { phase: "backoff" }]),
          retryNow: Ref.update(retries, (count) => count + 1),
        }),
        { startImmediately: true },
      );

      // Each nudge waits out the interval first, so nothing fires immediately.
      yield* TestClock.adjust(Duration.millis(999));
      expect(yield* Ref.get(retries)).toBe(0);

      yield* TestClock.adjust(Duration.millis(1));
      expect(yield* Ref.get(retries)).toBe(1);

      yield* TestClock.adjust(Duration.seconds(1));
      expect(yield* Ref.get(retries)).toBe(2);

      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("provider usage compatibility", () => {
  it.effect("falls back only when an older server rejects the subscription RPC tag", () =>
    Effect.gen(function* () {
      const fallback = Stream.make("legacy snapshot");
      const values = yield* withProviderUsageLegacyFallback(
        Stream.die(`Unknown request tag: ${WS_METHODS.serverSubscribeProviderUsage}`),
        fallback,
      ).pipe(Stream.runCollect);
      expect(values).toEqual(["legacy snapshot"]);

      const unrelatedFailure = yield* withProviderUsageLegacyFallback(
        Stream.die("provider usage decoder failed"),
        fallback,
      ).pipe(Stream.runCollect, Effect.exit);
      expect(Exit.isFailure(unrelatedFailure)).toBe(true);
    }),
  );
});

describe("server state projection", () => {
  it("only treats a legacy transport interruption as an unacknowledged handoff", () => {
    expect(isLegacyUpdateHandoffLoss(Cause.interrupt(1))).toBe(true);
    expect(
      isLegacyUpdateHandoffLoss(
        Cause.fail(
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isLegacyUpdateHandoffLoss(
        Cause.fail(
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketOpenError({
              kind: "Unknown",
              cause: new Error("connection refused"),
            }),
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isLegacyUpdateHandoffLoss(
        Cause.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: "incompatible protocol",
              cause: new Error("invalid response"),
            }),
          }),
        ),
      ),
    ).toBe(false);
    expect(isLegacyUpdateHandoffLoss(Cause.fail(new Error("Install failed.")))).toBe(false);
  });

  it.effect("resumes after the progress stream disconnects following completion", () => {
    const result = {
      targetVersion: "0.0.31",
      method: "respawn" as const,
    };
    const disconnect = new RpcClientError.RpcClientError({
      reason: new Socket.SocketCloseError({ code: 1006 }),
    });

    return Effect.gen(function* () {
      const resumed = yield* resolveServerUpdateProgressResult(
        result.targetVersion,
        Option.some(result),
        Exit.fail(disconnect),
      );
      expect(resumed).toEqual(result);
    });
  });

  it("projects streamed update milestones into the shared operation state", () => {
    expect(
      serverUpdateStateForProgressEvent("0.0.30", "0.0.31", {
        type: "progress",
        stage: "installing",
      }),
    ).toEqual({
      status: "running",
      stage: "installing",
      fromVersion: "0.0.30",
      targetVersion: "0.0.31",
    });
    expect(
      serverUpdateStateForProgressEvent("0.0.30", "0.0.31", {
        type: "complete",
        result: { targetVersion: "0.0.31", method: "respawn" },
      }),
    ).toEqual({
      status: "running",
      stage: "resuming",
      fromVersion: "0.0.30",
      targetVersion: "0.0.31",
    });
  });

  it("keeps a prepared desktop update installing until the commit and uses its actual version", () => {
    expect(
      serverUpdateStateForProgressEvent("0.0.30", "0.0.31", {
        type: "complete",
        result: {
          targetVersion: "0.0.34",
          method: "desktop-app",
          desktopUpdateToken: "prepared-update",
        },
      }),
    ).toEqual({
      status: "running",
      stage: "installing",
      fromVersion: "0.0.30",
      targetVersion: "0.0.34",
    });
  });

  it("keeps active update state even when the target or a newer version arrives", () => {
    const running = {
      status: "running" as const,
      stage: "resuming" as const,
      fromVersion: "0.0.30",
      targetVersion: "0.0.31",
    };
    expect(serverUpdateStateForServerVersion(running, "0.0.31")).toBe(running);
    expect(serverUpdateStateForServerVersion(running, "0.0.32")).toBe(running);
  });

  it.each([
    ["1.1.0", "1.1.0"],
    ["1.1.0", "1.2.0"],
    ["1.9.0", "1.10.0"],
    ["1.1.0", "v1.1.0"],
    ["1.1.0-nightly.9", "1.1.0-nightly.10"],
    ["1.1.0-nightly.10", "1.1.0"],
    ["custom-build", "custom-build"],
  ])(
    "clears a failed update to %s when the server is already on %s",
    (targetVersion, serverVersion) => {
      const failed = {
        status: "failed" as const,
        stage: "installing" as const,
        fromVersion: "1.0.0",
        targetVersion,
        message: "Install failed.",
      };

      expect(serverUpdateStateForServerVersion(failed, serverVersion)).toEqual({ status: "idle" });
    },
  );

  it.each([
    ["1.1.0", "1.0.0"],
    ["1.1.0", null],
    ["1.1.0", "1.1.0-nightly.10"],
    ["1.1.0-nightly.10", "1.1.0-nightly.9"],
    ["1.1.0", "unknown"],
    ["custom-build", "newer-custom-build"],
    ["custom-build", "2.0.0"],
  ])(
    "retains a failed update to %s when server version %s does not establish recovery",
    (targetVersion, serverVersion) => {
      const failed = {
        status: "failed" as const,
        stage: "installing" as const,
        fromVersion: "1.0.0",
        targetVersion,
        message: "Install failed.",
      };

      expect(serverUpdateStateForServerVersion(failed, serverVersion)).toBe(failed);
    },
  );

  it.effect("correlates launcher outcomes and fails immediately after rollback", () =>
    Effect.gen(function* () {
      const result = {
        targetVersion: "0.0.31",
        method: "boot-service" as const,
        updateId: "update-1",
      };
      const ready = (status: "committed" | "rolled-back") =>
        ({
          version: 1 as const,
          sequence: 1,
          type: "ready" as const,
          payload: {
            at: "2026-08-01T00:00:00.000Z",
            environment: { serverVersion: status === "committed" ? "0.0.31" : "0.0.30" },
            updateOutcome: {
              id: "update-1",
              fromVersion: "0.0.30",
              targetVersion: "0.0.31",
              status,
              ...(status === "rolled-back" ? { reason: "prepared-timeout" } : {}),
            },
          },
        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];

      expect(matchesServerUpdateReadyEvent(result, ready("committed"))).toBe(true);
      yield* validateServerUpdateReadyEvent(result, ready("committed"));
      const rollback = yield* Effect.flip(
        validateServerUpdateReadyEvent(result, ready("rolled-back")),
      );
      expect(rollback.message).toBe("prepared-timeout");
    }),
  );

  it("requires tokenless desktop updates to reach the target version", () => {
    const ready = (serverVersion: string) =>
      ({
        version: 1 as const,
        sequence: 1,
        type: "ready" as const,
        payload: {
          at: "2026-09-01T00:00:00.000Z",
          environment: { serverVersion },
        },
      }) as Parameters<typeof matchesServerUpdateResumeEvent>[1];

    expect(
      matchesServerUpdateResumeEvent(
        { targetVersion: "0.0.31", method: "desktop-app" },
        ready("0.0.30"),
      ),
    ).toBe(false);
    expect(
      matchesServerUpdateResumeEvent(
        {
          targetVersion: "0.0.31",
          method: "desktop-app",
          desktopUpdateToken: "update-1",
        },
        ready("0.0.30"),
      ),
    ).toBe(true);
  });

  it("applies every config category to the projected snapshot", () => {
    const snapshot = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "snapshot",
      config: CONFIG,
    });
    const settings = { ...CONFIG.settings };
    const projected = applyServerConfigProjection(snapshot, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });

    const result = Option.getOrThrow(projected);
    expect(result.config.settings).toBe(settings);
    expect(result.latestEvent.type).toBe("settingsUpdated");
  });

  it("retains welcome when a ready event follows in the same stream chunk", () => {
    const welcome = {
      environment: {} as ServerLifecycleWelcomePayload["environment"],
      cwd: "/repo",
      projectName: "repo",
    } as ServerLifecycleWelcomePayload;
    const [afterWelcome] = projectServerWelcome(Option.none(), {
      type: "welcome",
      payload: welcome,
    });
    const [afterReady, emitted] = projectServerWelcome(afterWelcome, {
      type: "ready",
      payload: {},
    });

    expect(Option.getOrThrow(afterReady)).toBe(welcome);
    expect(emitted).toEqual([]);
  });

  it("prefers an active session config over cache until a live event arrives", () => {
    const config = (source: string, serverVersion: string) =>
      ({
        ...CONFIG,
        environment: { serverVersion },
        settings: { source },
      }) as unknown as ServerConfig;
    const cached = config("cache", "0.0.29");
    const staleLive = config("stale-live", "0.0.29");
    const initial = config("session", "0.0.30");
    const live = config("live", "0.0.30");

    expect(
      resolveServerConfigValue(
        {
          config: cached,
          latestEvent: snapshotEvent(cached),
          source: "cache",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: staleLive,
          latestEvent: snapshotEvent(staleLive),
          source: "live",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: live,
          latestEvent: snapshotEvent(live),
          source: "live",
        },
        initial,
      ),
    ).toBe(live);
  });

  it.effect("starts from cached configuration and persists the live projection", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.some(CONFIG)),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerConfigState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          );
          expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(CONFIG);

          const providers: ServerConfig["providers"] = [];
          yield* Queue.offer(events, {
            version: 1,
            type: "providerStatuses",
            payload: { providers },
          });
          const projected = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) =>
              Option.match(value, {
                onNone: () => false,
                onSome: (projection) => projection.latestEvent.type === "providerStatuses",
              }),
            ),
            Stream.runHead,
          );
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.providers).toBe(providers);
        }),
      );

      expect((yield* Queue.take(savedConfigs)).providers).toEqual([]);
    }),
  );

  it.effect("does not rewrite cached configuration when no live update arrives", () =>
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.empty,
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.some(CONFIG)),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        makeEnvironmentServerConfigState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        ),
      );

      expect(yield* Queue.poll(savedConfigs)).toEqual(Option.none());
    }),
  );
});
