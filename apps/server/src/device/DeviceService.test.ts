import {
  DeviceControlCaller,
  DEVICE_CONTROL_CALL_TIMEOUT,
  DEVICE_CONTROL_TTL,
} from "./DeviceControl.ts";
import { AgentDeviceRequest } from "./DeviceAgentGateway.ts";
import { TestClock } from "effect/testing";
import { RunId } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DeviceId,
  DeviceOperationError,
  LOCAL_DEVICE_HOST_ID,
  ThreadId,
  DeviceServiceState,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { NodeRuntimeUnavailableError } from "./nodeRuntime.ts";
import { AndroidSdkInstallError } from "./androidSdkInstall.ts";

import { type DeviceService, makeWithHosts, stateStream } from "./DeviceService.ts";

const encodeState = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(DeviceServiceState)),
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeAgentRequest = Schema.decodeUnknownSync(Schema.fromJsonString(AgentDeviceRequest));

const baseState: DeviceServiceState = {
  hosts: [],
  hostStatus: "idle",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
};

describe("DeviceService.stateStream", () => {
  it.effect("emits the current snapshot and then every published change", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<DeviceServiceState>();
      const current = yield* Ref.make(baseState);
      const service: Pick<DeviceService["Service"], "state" | "subscribe"> = {
        state: Ref.get(current),
        subscribe: PubSub.subscribe(pubsub),
      };

      const collected = yield* stateStream(service as DeviceService["Service"]).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      for (const revision of [1, 2]) {
        const next = { ...baseState, revision, hostStatus: "ready" as const };
        yield* Ref.set(current, next);
        yield* PubSub.publish(pubsub, next);
      }
      const seen = yield* Fiber.join(collected);
      expect(seen.map((state) => state.revision)).toEqual([0, 1, 2]);
    }),
  );

  it.effect("drops changes queued before the snapshot it already reflects", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<DeviceServiceState>();
      const service: Pick<DeviceService["Service"], "state" | "subscribe"> = {
        // Revision 1 lands after the subscription opens but before the snapshot is read.
        state: PubSub.publish(pubsub, { ...baseState, revision: 1 }).pipe(
          Effect.as({ ...baseState, revision: 2 }),
        ),
        subscribe: PubSub.subscribe(pubsub),
      };

      const collected = yield* stateStream(service as DeviceService["Service"]).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* PubSub.publish(pubsub, { ...baseState, revision: 3 });
      const seen = yield* Fiber.join(collected);
      expect(seen.map((state) => state.revision)).toEqual([2, 3]);
    }),
  );
});

const asLifecycleAgent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(DeviceControlCaller, {
      kind: "agent",
      threadId: "lifecycle-test",
      runId: "lifecycle-run",
    }),
  );

const fixture = Effect.fn("fixture")(function* (
  onBoot: Effect.Effect<void> = Effect.void,
  bootError?: string,
  failListAfterShutdown = false,
  runtimeFailure?: NodeRuntimeUnavailableError | DeviceHost.DeviceHostError,
  inspectError = false,
  installTool?: Parameters<typeof makeWithHosts>[3],
  hostOverrides: Partial<DeviceHost.DeviceHost["Service"]> = {},
  configureAgent?: Parameters<typeof makeWithHosts>[2],
  grantAgentTarget?: Parameters<typeof makeWithHosts>[4],
  onAgentCommand: Effect.Effect<void> = Effect.void,
  onShutdown: Effect.Effect<void> = Effect.void,
) {
  const settings = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
  const starts: string[] = [];
  const agentStarts: string[] = [];
  const agentStops: string[] = [];
  const requests: string[] = [];
  const agentRequests: (typeof AgentDeviceRequest.Type)[] = [];
  let booted = false;
  let shutDown = false;
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.succeed({ code: 0, stdout: "Pixel_API_35\n", stderr: "" }),
  };
  const host: DeviceHost.DeviceHost["Service"] = {
    acquireDevice: () => Effect.succeed(null),
    deviceOwners: () => Effect.succeed({}),
    ...(inspectError
      ? {
          inspect: Effect.fail(
            new DeviceHost.DeviceHostError({
              hostId: LOCAL_DEVICE_HOST_ID,
              step: "probe",
              cause: new Error("offline"),
            }),
          ),
        }
      : {}),
    id: LOCAL_DEVICE_HOST_ID,
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Test server",
      platforms: [{ platform: "android", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: false,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: (onPhase) =>
      Effect.gen(function* () {
        if (runtimeFailure) return yield* runtimeFailure;
        starts.push("start");
        yield* onPhase("installing", "Updating device hub from 0.9.0 to 0.10.1…");
        return ready;
      }),
    ensureAgentReady: (onPhase) =>
      Effect.gen(function* () {
        if (runtimeFailure) return yield* runtimeFailure;
        agentStarts.push("start");
        yield* onPhase("starting");
        return {
          ...ready,
          agentDevice: { baseUrl: "http://agent.test", token: "test", entryPath: "/agent" },
        };
      }),
    current: Effect.succeed(null),
    stopAgent: Effect.sync(() => {
      agentStops.push("stop");
    }),
    stop: Effect.sync(() => {
      starts.push("stop");
    }),
    ...hostOverrides,
  };
  const service = yield* makeWithHosts(
    new Map([[host.id, host]]),
    undefined,
    configureAgent,
    installTool,
    grantAgentTarget,
  ).pipe(
    Effect.provideService(DeviceHost.DeviceHost, host),
    Effect.provideService(
      ServerSettingsService,
      ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settings),
        updateSettings: (patch) =>
          Ref.updateAndGet(settings, (current) => ({
            ...current,
            enableDeviceSupport: patch.enableDeviceSupport ?? current.enableDeviceSupport,
            enableAgentDeviceAccess:
              patch.enableAgentDeviceAccess ?? current.enableAgentDeviceAccess,
            deviceOnboardingCompleted:
              patch.deviceOnboardingCompleted ?? current.deviceOnboardingCompleted,
          })),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          if (request.url.endsWith("/rpc")) {
            if (request.body._tag !== "Uint8Array")
              return yield* Effect.die("Expected JSON request");
            agentRequests.push(decodeAgentRequest(new TextDecoder().decode(request.body.body)));
            yield* onAgentCommand;
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ jsonrpc: "2.0", id: "request", result: { ok: true } }),
            );
          }
          if (request.url.includes("/api/screenshot")) {
            return HttpClientResponse.fromWeb(
              request,
              new Response(new Uint8Array([137, 80, 78, 71])),
            );
          }
          if (request.url.endsWith("/shutdown")) {
            yield* onShutdown;
            shutDown = true;
            booted = false;
            return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
          }
          if (shutDown && failListAfterShutdown) {
            return HttpClientResponse.fromWeb(
              request,
              new Response("Discovery busy", { status: 503 }),
            );
          }
          if (request.url.endsWith("/boot")) {
            yield* onBoot;
            booted = true;
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                bootError ? { ok: false, error: bootError } : { ok: true, serial: "emulator-5554" },
              ),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              simulators: [],
              emulators: booted
                ? [
                    {
                      id: "emulator-5554",
                      name: "Pixel_API_35",
                      platform: "android",
                      version: "Android 15",
                      booted: true,
                      physical: false,
                    },
                  ]
                : [],
            }),
          );
        }),
      ),
    ),
  );
  return { service, starts, agentStarts, agentStops, requests, agentRequests, settings };
});

describe("device setup consent", () => {
  it.effect(
    "preserves missing-runtime guidance and causes through manual and agent readiness",
    () =>
      Effect.gen(function* () {
        const underlying = new Error("private lookup diagnostics");
        const runtimeFailure = new NodeRuntimeUnavailableError({
          feature: "Local device support",
          cause: underlying,
        });
        const { service, settings, requests } = yield* fixture(
          Effect.void,
          undefined,
          false,
          runtimeFailure,
        );
        yield* Ref.update(settings, (current) => ({
          ...current,
          enableDeviceSupport: true,
          enableAgentDeviceAccess: true,
        }));
        for (const readiness of [service.readiness(), service.agentReadinessIfSupported()]) {
          const error = yield* readiness.pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DeviceHostUnavailableError",
            reason: expect.stringContaining("Install Node.js"),
            cause: runtimeFailure,
          });
          expect(error.message).not.toContain(underlying.message);
        }
        expect((yield* service.state).hostStatuses[LOCAL_DEVICE_HOST_ID]).toMatchObject({
          status: "failed",
          detail: expect.stringContaining("Install Node.js"),
        });
        expect(requests).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("listing and provider startup do not start helpers before consent", () =>
    Effect.gen(function* () {
      const { service, starts, requests } = yield* fixture();
      expect((yield* service.list).hostStatus).toBe("disabled");
      expect(yield* service.readinessIfSupported()).toBeNull();
      const readiness = yield* service.readiness().pipe(Effect.result);
      expect(readiness._tag).toBe("Failure");
      expect(starts).toEqual([]);
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "explicit setup discovers never-booted AVDs; disabling stops helpers and blocks agents",
    () =>
      Effect.gen(function* () {
        const { service, starts, settings } = yield* fixture();
        const state = yield* service.configure({ enabled: true });
        expect((yield* Ref.get(settings)).enableDeviceSupport).toBe(true);
        expect(state.devices.map((device) => [device.id, device.booted])).toEqual([
          ["Pixel_API_35", false],
        ]);
        expect(starts).toEqual(["start"]);
        const disabled = yield* service.configure({ enabled: false });
        expect(disabled.hostStatus).toBe("disabled");
        expect(disabled.devices).toEqual([]);
        expect((yield* Ref.get(settings)).enableDeviceSupport).toBe(false);
        expect(yield* service.readinessIfSupported()).toBeNull();
        expect(starts).toEqual(["start", "stop"]);
      }).pipe(Effect.scoped),
  );

  it.effect("boots a stopped Android AVD and uses its emulator serial without duplicating it", () =>
    Effect.gen(function* () {
      const { service, requests } = yield* fixture();
      yield* service.configure({ enabled: true });
      const session = yield* service.open({
        threadId: ThreadId.make("thread-1"),
        deviceId: "Pixel_API_35",
        platform: "android",
      });
      expect(session.deviceId).toBe("emulator-5554");
      expect(requests.filter((url) => url.endsWith("/boot"))).toHaveLength(1);
      const state = yield* service.state;
      expect(state.devices.map((device) => device.id)).toEqual(["emulator-5554"]);
      expect(state.bootingDevices).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("installs agent support only after the separate agent permission", () =>
    Effect.gen(function* () {
      const { service, agentStarts, agentStops, settings } = yield* fixture();
      yield* service.configure({ enabled: true });
      expect(agentStarts).toEqual([]);
      expect(yield* service.agentReadinessIfSupported()).toBeNull();

      yield* service.configure({ agentAccessEnabled: true });
      expect(agentStarts).toEqual(["start"]);
      expect((yield* Ref.get(settings)).enableAgentDeviceAccess).toBe(true);
      expect((yield* service.state).agentAccessEnabled).toBe(true);

      yield* service.configure({ agentAccessEnabled: false, onboardingCompleted: true });
      expect(agentStops).toEqual(["stop"]);
      expect((yield* service.state).onboardingCompleted).toBe(true);
      expect((yield* Ref.get(settings)).deviceOnboardingCompleted).toBe(true);
    }).pipe(Effect.scoped),
  );
});

it.effect("publishes boot progress and does not restore sessions after support is disabled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const { service } = yield* fixture(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    );
    yield* service.configure({ enabled: true });
    const opening = yield* service
      .open({ threadId: ThreadId.make("thread-1"), deviceId: "Pixel_API_35", platform: "android" })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(started);
    expect((yield* service.state).bootingDevices?.map((device) => device.name)).toEqual([
      "Pixel_API_35",
    ]);
    yield* service.configure({ enabled: false });
    yield* Deferred.succeed(finish, undefined);
    expect((yield* Fiber.join(opening))._tag).toBe("Failure");
    const state = yield* service.state;
    expect(state.hostStatus).toBe("disabled");
    expect(state.devices).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.bootingDevices).toEqual([]);
  }).pipe(Effect.scoped),
);

describe("device discovery after server restart", () => {
  it.effect("captures an explicit device before any client lists devices", () =>
    Effect.gen(function* () {
      const { service, settings, requests } = yield* fixture();
      yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));
      expect((yield* service.state).devices).toEqual([]);
      const capture = yield* service.screenshot({ deviceId: DeviceId.make("Pixel_API_35") });
      expect(capture.device.id).toBe("Pixel_API_35");
      expect(Array.from(capture.png)).toEqual([137, 80, 78, 71]);
      expect(requests.some((url) => url.endsWith("/api/devices"))).toBe(true);
    }).pipe(Effect.scoped),
  );
});

for (const [diagnostic, reason, message] of [
  ["Insufficient disk space at /private/user/path", "disk_space", "not enough free disk space"],
  ["Timed out spawning /private/user/command", "timeout", "did not become ready in time"],
  ["Unexpected failure: secret-token", "launch_failed", "could not start"],
] as const) {
  it.effect(`normalizes boot failure: ${reason}`, () =>
    Effect.gen(function* () {
      const { service } = yield* fixture(Effect.void, diagnostic);
      yield* service.configure({ enabled: true });
      const error = yield* service
        .open({
          threadId: ThreadId.make("boot-failure"),
          deviceId: "Pixel_API_35",
          platform: "android",
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("DeviceBootError");
      expect(error.message).toContain(message);
      expect(error.message).not.toContain(diagnostic);
      expect((yield* service.state).bootingDevices).toEqual([]);
    }).pipe(Effect.scoped),
  );
}

it.effect("keeps shutdown successful when subsequent discovery fails", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture(Effect.void, undefined, true);
    yield* service.configure({ enabled: true });
    const threadId = ThreadId.make("shutdown-refresh");
    const session = yield* service.open({
      threadId,
      deviceId: "Pixel_API_35",
      platform: "android",
    });
    yield* asLifecycleAgent(
      service.close({ threadId, deviceId: session.deviceId, shutdown: true }),
    );
    const state = yield* service.state;
    expect(state.sessions).toEqual([]);
    expect(state.devices.find((device) => device.id === session.deviceId)?.booted).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect.each(["shutdown", "close"] as const)(
  "%s releases iOS capture so reopening uses a fresh session",
  (operation) =>
    Effect.gen(function* () {
      const deviceId = DeviceId.make("11111111-1111-1111-1111-111111111111");
      const threadId = ThreadId.make("capture-recovery");
      let booted = true;
      let capture: number | null = null;
      let generation = 0;
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        acquireDevice: () => Effect.succeed(null),
        deviceOwners: () => Effect.succeed({}),
        id: LOCAL_DEVICE_HOST_ID,
        summary: Effect.succeed({
          id: LOCAL_DEVICE_HOST_ID,
          kind: "local",
          label: "Simulator host",
          platforms: [{ platform: "ios", available: true }],
          hubInstalled: true,
          agentDeviceInstalled: false,
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          if (path === "/api/devices") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                emulators: [],
                simulators: [
                  {
                    id: deviceId,
                    name: "iPhone",
                    platform: "ios",
                    version: "26",
                    physical: false,
                    booted,
                  },
                ],
              }),
            );
          }
          if (path === "/vendor/serve-sim/grid/api/start") capture ??= ++generation;
          else if (path === "/vendor/serve-sim/grid/api/shutdown") {
            if (request.body._tag !== "Uint8Array") throw new Error("Missing shutdown body");
            expect(decodeJson(new TextDecoder().decode(request.body.body))).toEqual({
              udid: deviceId,
            });
            capture = null;
            booted = false;
          } else if (path === "/api/devices/shutdown") {
            // This route powers off without releasing serve-sim's cached capture.
            booted = false;
          } else if (path === "/api/devices/boot") booted = true;
          else throw new Error(`Unexpected hub path: ${path}`);
          return HttpClientResponse.fromWeb(request, Response.json({ ok: true, id: deviceId }));
        }),
      );
      const service = yield* makeWithHosts(new Map([[host.id, host]])).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const input = { threadId, deviceId, platform: "ios" as const };
      yield* service.open(input);
      expect(capture).toBe(1);
      if (operation === "shutdown") yield* asLifecycleAgent(service.shutdown(input));
      else yield* asLifecycleAgent(service.close({ threadId, deviceId, shutdown: true }));
      expect(capture).toBeNull();
      expect((yield* service.state).sessions).toEqual([]);
      yield* service.open(input);
      expect(capture).toBe(2);
      expect((yield* service.state).sessions).toHaveLength(1);
    }).pipe(
      Effect.provide(ServerSettingsService.layerTest({ enableDeviceSupport: true })),
      Effect.scoped,
    ),
);

it.effect.each([
  { hubReports: "off", outcome: "succeeds" },
  { hubReports: "booted", outcome: "fails" },
  { hubReports: "missing", outcome: "fails" },
] as const)(
  "iOS shutdown $outcome when serve-sim rejects it and the hub reports the simulator $hubReports",
  ({ hubReports, outcome }) =>
    Effect.gen(function* () {
      const deviceId = DeviceId.make("22222222-2222-2222-2222-222222222222");
      const paths: string[] = [];
      // The device list is stale until shutdown re-reads it from the hub.
      let listed: "booted" | "off" | "missing" = "booted";
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        acquireDevice: () => Effect.succeed(null),
        deviceOwners: () => Effect.succeed({}),
        id: LOCAL_DEVICE_HOST_ID,
        summary: Effect.succeed({
          id: LOCAL_DEVICE_HOST_ID,
          kind: "local",
          label: "Simulator host",
          platforms: [{ platform: "ios", available: true }],
          hubInstalled: true,
          agentDeviceInstalled: false,
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path === "/api/devices") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                emulators: [],
                simulators:
                  listed === "missing"
                    ? []
                    : [
                        {
                          id: deviceId,
                          name: "iPhone",
                          platform: "ios",
                          version: "26",
                          physical: false,
                          booted: listed === "booted",
                        },
                      ],
                // A partial listing still decodes; it must not read as "off".
                errors: listed === "missing" ? [{ message: "simctl list failed" }] : [],
              }),
            );
          }
          if (path === "/vendor/serve-sim/grid/api/shutdown") {
            // serve-sim runs `simctl shutdown` bare and returns its failure as-is.
            listed = hubReports;
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                { ok: false, error: "Unable to shutdown device in current state: Shutdown" },
                { status: 500 },
              ),
            );
          }
          throw new Error(`Unexpected hub path: ${path}`);
        }),
      );
      const service = yield* makeWithHosts(new Map([[host.id, host]])).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      yield* service.list;
      const exit = yield* Effect.exit(
        asLifecycleAgent(service.shutdown({ deviceId, platform: "ios" })),
      );
      expect(paths.filter((path) => path.endsWith("shutdown"))).toEqual([
        "/vendor/serve-sim/grid/api/shutdown",
      ]);
      if (outcome === "succeeds") {
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(
          (yield* service.state).devices.find((device) => device.id === deviceId)?.booted,
        ).toBe(false);
      } else {
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          (yield* service.state).devices.find((device) => device.id === deviceId)?.booted,
        ).toBe(true);
      }
    }).pipe(
      Effect.provide(ServerSettingsService.layerTest({ enableDeviceSupport: true })),
      Effect.scoped,
    ),
);

it.effect("retry keeps device and agent consent unchanged", () =>
  Effect.gen(function* () {
    const { service, starts, agentStarts } = yield* fixture();
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
    yield* service.configure({ enabled: true });
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(agentStarts).toEqual([]);
    yield* service.configure({ agentAccessEnabled: true });
    const before = agentStarts.length;
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(agentStarts.length).toBe(before + 1);
  }).pipe(Effect.scoped),
);

it.effect("publishes update detail for the correct host", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture();
    const changes = yield* service.subscribe;
    yield* service.configure({ enabled: true });
    const states = yield* PubSub.takeAll(changes);
    expect(
      states.some(
        (state) => state.hostStatuses.local?.detail === "Updating device hub from 0.9.0 to 0.10.1…",
      ),
    ).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("host retry exposes actionable failure without internal IDs or diagnostics", () =>
  Effect.gen(function* () {
    const { service, settings } = yield* fixture(
      Effect.void,
      undefined,
      false,
      new DeviceHost.DeviceHostError({
        hostId: LOCAL_DEVICE_HOST_ID,
        step: "probe",
        cause: "private diagnostics",
      }),
    );
    yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));
    const state = yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(state.supportsHostRetry).toBe(true);
    expect(state.hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
      status: "failed",
      detail: "Could not connect to this host over SSH.",
    });
  }).pipe(Effect.scoped),
);

it.effect("version discovery does not grant consent or start device tools", () =>
  Effect.gen(function* () {
    const { service, starts, agentStarts, requests } = yield* fixture();
    const state = yield* service.inspect;
    expect(state.supportsToolInspection).toBe(true);
    expect(state.hostStatus).toBe("disabled");
    expect(state.hosts).toHaveLength(1);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
    expect(requests).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("failed read-only discovery preserves lifecycle status and installed inventory", () =>
  Effect.gen(function* () {
    const { service, starts } = yield* fixture(Effect.void, undefined, false, undefined, true);
    const state = yield* service.inspect;
    expect(state.supportsToolInspection).toBe(true);
    expect(state.hostStatus).toBe("disabled");
    expect(state.hosts[0]?.hubInstalled).toBe(true);
    expect(state.hosts[0]?.toolInspectionError).toContain("Reconnect the host");
    expect(starts).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "manual updates install only the selected tool without enabling access or starting helpers",
  () =>
    Effect.gen(function* () {
      const installed: string[] = [];
      const { service, starts, agentStarts, requests } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        (tool) =>
          Effect.sync(() => {
            installed.push(tool);
          }),
      );
      const before = yield* service.state;
      const state = yield* service.updateTool("agent");
      expect(installed).toEqual(["agent"]);
      expect(state.supportsToolUpdate).toBe(true);
      expect(state.hostStatus).toBe(before.hostStatus);
      expect(state.agentAccessEnabled).toBe(before.agentAccessEnabled);
      expect(state.revision).toBe(before.revision);
      expect(starts).toEqual([]);
      expect(agentStarts).toEqual([]);
      expect(requests).toEqual([]);
      yield* service.updateTool("hub");
      expect(installed).toEqual(["agent", "hub"]);
    }).pipe(Effect.scoped),
);

it.effect("failed manual installation leaves lifecycle state unchanged and can be retried", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const { service, starts, agentStarts } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      () =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(
                new DeviceOperationError({
                  operation: "update device tool",
                  reason: "command_failed",
                  cause: new Error("offline"),
                }),
              )
            : Effect.void,
        ),
    );
    const before = yield* service.state;
    const result = yield* service.updateTool("agent").pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(yield* service.state).toEqual(before);
    yield* service.updateTool("agent");
    expect(attempts).toBe(2);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("returns only an environment-relative media path to remote clients", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture();
    yield* service.configure({ enabled: true });
    const session = yield* service.open({
      threadId: ThreadId.make("remote-viewer"),
      deviceId: DeviceId.make("Pixel_API_35"),
      platform: "android",
    });
    const state = yield* service.list;
    const payload = yield* encodeState(state);
    expect(payload).not.toMatch(/device\.test|127\.0\.0\.1|localhost|https?:|wss?:/);
    expect(state.hubBasePath).toBe("/api/device-hub");
    expect(session).toEqual(
      expect.objectContaining({ hostId: "local", deviceId: "emulator-5554" }),
    );
    for (const origin of ["https://environment.example.test", "http://192.168.1.20:3774"]) {
      expect(new URL(`${state.hubBasePath}/vendor/serve-emu/ws`, origin).origin).toBe(origin);
    }
  }),
);

it.effect("does not broadcast unchanged inspection snapshots", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture();
    const changes = yield* service.subscribe;
    const before = yield* service.state;
    yield* service.inspect;
    yield* service.inspect;
    expect(yield* service.state).toEqual(before);
    const changed = yield* service.setHostStatus("local", { status: "installing" });
    expect(yield* PubSub.takeAll(changes)).toEqual([changed]);
  }).pipe(Effect.scoped),
);

it.effect(
  "updates all pinned tools per environment and leaves consent and sessions unchanged",
  () =>
    Effect.gen(function* () {
      const installed: string[] = [];
      const { service, starts, agentStarts } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        (tool) =>
          Effect.sync(() => {
            installed.push(tool);
          }),
      );
      const before = yield* service.state;
      yield* service.updateTools({});
      expect(installed).toEqual(["hub", "agent"]);
      yield* service.updateTools({ tools: ["agent", "agent"] });
      expect(installed).toEqual(["hub", "agent", "agent"]);
      expect(yield* service.state).toEqual(before);
      expect(starts).toEqual([]);
      expect(agentStarts).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect("failed environment updates are retryable and never start helpers", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const { service, starts } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      () =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(
                new DeviceOperationError({
                  operation: "update",
                  reason: "command_failed",
                  cause: new Error("offline"),
                }),
              )
            : Effect.void,
        ),
    );
    const before = yield* service.state;
    expect((yield* service.updateTools({ tools: ["hub"] }).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(yield* service.state).toEqual(before);
    yield* service.updateTools({ tools: ["hub"] });
    expect(attempts).toBe(2);
    expect(starts).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("denies boot, shutdown and automation when another environment owns the device", () =>
  Effect.gen(function* () {
    const owner = { environmentId: "other", environmentLabel: "Other Mac environment" };
    const { service, requests } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      {
        acquireDevice: () => Effect.succeed(owner),
        deviceOwners: (keys) => Effect.succeed(Object.fromEntries(keys.map((key) => [key, owner]))),
      },
    );
    yield* service.configure({ enabled: true });
    const device = (yield* service.state).devices[0]!;
    expect(device.inUseBy).toEqual(owner);
    const input = {
      threadId: ThreadId.make("lease-test"),
      deviceId: device.id,
      platform: device.platform,
    };
    const failure = yield* service.open(input).pipe(Effect.flip);
    expect(failure.message).toContain("In use by Other Mac environment");
    expect((yield* service.shutdown(input).pipe(Effect.result))._tag).toBe("Failure");
    expect(
      (yield* service
        .agentTarget({ runId: RunId.make("run-test"), ...input, hostId: "local" })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(requests.some((value) => value.endsWith("/boot") || value.endsWith("/shutdown"))).toBe(
      false,
    );
  }).pipe(Effect.scoped),
);

it.effect("keeps lifecycle operations available while an update waits for a download", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const { service } = yield* fixture(Effect.void, undefined, false, undefined, false, () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    );
    const update = yield* service.updateTools({ tools: ["hub"] }).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect((yield* service.configure({ enabled: false })).hostStatus).toBe("disabled");
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(update);
  }).pipe(Effect.scoped),
);

it.effect("clears stale ownership status when a released simulator is acquired", () =>
  Effect.gen(function* () {
    let owner: { environmentId: string; environmentLabel: string } | null = {
      environmentId: "other",
      environmentLabel: "Other",
    };
    const { service } = yield* fixture(Effect.void, undefined, false, undefined, false, undefined, {
      acquireDevice: () => Effect.sync(() => owner),
      deviceOwners: (keys) =>
        Effect.sync(() => {
          const held = owner;
          return held ? Object.fromEntries(keys.map((key) => [key, held])) : {};
        }),
    });
    yield* service.configure({ enabled: true });
    const device = (yield* service.state).devices[0]!;
    expect(device.inUseBy).toEqual(owner);
    owner = null;
    yield* service.claimDevice("local", device.id);
    expect((yield* service.state).devices[0]?.inUseBy).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.effect("restarts selected helpers without closing sessions or releasing ownership", () =>
  Effect.gen(function* () {
    const restarted: ReadonlyArray<"hub" | "agent">[] = [];
    const { service, starts, agentStops } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      {
        restartTools: (tools) =>
          Effect.sync(() => {
            restarted.push(tools);
            return null;
          }),
      },
    );
    yield* service.configure({ enabled: true });
    yield* service.open({
      threadId: ThreadId.make("restart-session"),
      deviceId: "Pixel_API_35",
      platform: "android",
    });
    const before = yield* service.state;
    const startsBefore = [...starts];
    const result = yield* service.restartTools({ tools: ["hub", "hub"] });
    expect(restarted).toEqual([["hub"]]);
    expect(result.sessions).toEqual(before.sessions);
    expect(result.devices).toEqual(before.devices);
    expect(starts).toEqual(startsBefore);
    expect(agentStops).toEqual([]);
    yield* service.restartTools({});
    expect(restarted[1]).toEqual(["hub", "agent"]);
    expect((yield* service.restartTools({ hostId: "missing" }).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
  }).pipe(Effect.scoped),
);

it.effect("invalidates existing agent grants when restart changes the daemon endpoint", () =>
  Effect.gen(function* () {
    let endpoint = "";
    const grants: string[] = [];
    const { service } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      {
        restartTools: () =>
          Effect.succeed({
            nodePath: process.execPath,
            hub: { origin: "http://device.test" },
            helpers: { serveSimAxSettings: null, serveSimCli: null },
            run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
            agentDevice: { baseUrl: "http://restarted.test", token: "new", entryPath: "/agent" },
          }),
      },
      (_hostId, ready) =>
        Effect.sync(() => {
          endpoint = ready.agentDevice.baseUrl;
          return "/config";
        }),
      () =>
        Effect.sync(() => {
          grants.push(endpoint);
        }),
    );
    yield* service.configure({ enabled: true, agentAccessEnabled: true });
    yield* service.open({
      threadId: ThreadId.make("agent-restart"),
      deviceId: "Pixel_API_35",
      platform: "android",
    });
    yield* service.agentTarget({
      runId: RunId.make("run-test"),
      threadId: ThreadId.make("agent-restart"),
      hostId: "local",
      deviceId: "emulator-5554",
    });
    yield* service.restartTools({ tools: ["agent"] });
    expect(grants).toEqual(["http://agent.test"]);
    expect((yield* service.state).controls?.every((state) => state.owner === null)).toBe(true);
    yield* service.configure({ agentAccessEnabled: false });
    yield* service.restartTools({ tools: ["hub"] });
    expect(grants).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "the agent gateway drains an accepted command before takeover and revokes its reusable token",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      let token = "";
      let session = "";
      const { service, requests } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        undefined,
        {},
        (_hostId, _ready, grant) =>
          Effect.sync(() => {
            token = grant!.token;
            session = grant!.session;
            return "/run-bound-config";
          }),
        undefined,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(done))),
      );
      yield* service.configure({ enabled: true, agentAccessEnabled: true });
      const opened = yield* service.open({
        threadId: ThreadId.make("thread"),
        deviceId: "Pixel_API_35",
        platform: "android",
      });
      yield* service.agentTarget({ ...opened, runId: RunId.make("run") });
      const request = {
        jsonrpc: "2.0" as const,
        id: "request",
        method: "agent_device.command" as const,
        params: {
          session,
          command: "click",
          positionals: ["@e1"],
          flags: { platform: "android", serial: opened.deviceId },
        },
      };
      const command = yield* service.agentCommand(token, request).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const changes = yield* service.subscribe;
      const draining = yield* Stream.fromSubscription(changes).pipe(
        Stream.filter(
          (state) => state.controls?.some((control) => control.phase === "draining") ?? false,
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      let acknowledged = false;
      const takeover = yield* service.control
        .acquire(opened, { kind: "viewer", sessionId: "session", viewerId: "viewer" })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              acknowledged = true;
            }),
          ),
          Effect.forkChild,
        );
      yield* Fiber.join(draining);
      expect(acknowledged).toBe(false);
      const refused = yield* service.agentCommand(token, request).pipe(Effect.result);
      expect(refused._tag).toBe("Failure");
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(command);
      yield* Fiber.join(takeover);
      expect(acknowledged).toBe(true);
      expect((yield* service.agentCommand(token, request).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(requests.filter((url) => url.endsWith("/rpc"))).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect("shutdown rejects missing and stale viewer proofs before sending anything", () =>
  Effect.gen(function* () {
    const { service, requests } = yield* fixture();
    yield* service.configure({ enabled: true });
    const opened = yield* service.open({
      threadId: ThreadId.make("thread"),
      deviceId: "Pixel_API_35",
      platform: "android",
    });
    const caller = { kind: "viewer" as const, sessionId: "session" };
    const denied = yield* service
      .shutdown(opened)
      .pipe(Effect.provideService(DeviceControlCaller, caller), Effect.flip);
    expect(denied._tag).toBe("DeviceControlError");
    expect(requests.some((url) => url.endsWith("/shutdown"))).toBe(false);
    const held = yield* service.control.acquire(opened, { ...caller, viewerId: "viewer" });
    yield* service
      .shutdown({ ...opened, control: { viewerId: "viewer", generation: held.generation } })
      .pipe(Effect.provideService(DeviceControlCaller, caller));
    expect(
      (yield* service.state).controls?.find((control) => control.deviceId === opened.deviceId)
        ?.owner,
    ).toBeNull();
    expect(
      (yield* service
        .shutdown({ ...opened, control: { viewerId: "viewer", generation: held.generation } })
        .pipe(Effect.provideService(DeviceControlCaller, caller), Effect.flip))._tag,
    ).toBe("DeviceControlError");
    expect(requests.filter((url) => url.endsWith("/shutdown"))).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect("takeover does not wait on an agent command queued behind the host lifecycle lock", () =>
  Effect.gen(function* () {
    let token = "";
    let session = "";
    const { service, requests } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      {},
      (_hostId, _ready, grant) =>
        Effect.sync(() => {
          token = grant!.token;
          session = grant!.session;
          return "/config";
        }),
    );
    yield* service.configure({ enabled: true, agentAccessEnabled: true });
    const opened = yield* service.open({
      threadId: ThreadId.make("thread"),
      deviceId: "Pixel_API_35",
      platform: "android",
    });
    yield* service.agentTarget({ ...opened, runId: RunId.make("run") });
    const locked = yield* Deferred.make<void>();
    const unlock = yield* Deferred.make<void>();
    const lifecycle = yield* service
      .withLifecycleLock(
        Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(unlock))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(locked);
    const command = yield* service
      .agentCommand(token, {
        jsonrpc: "2.0",
        id: "queued",
        method: "agent_device.command",
        params: {
          session,
          command: "click",
          flags: { platform: "android", serial: opened.deviceId },
        },
      })
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    const acquired = yield* service.control.acquire(opened, {
      kind: "viewer",
      sessionId: "session",
      viewerId: "viewer",
    });
    expect(acquired.phase).toBe("held");
    yield* Deferred.succeed(unlock, undefined);
    yield* Fiber.join(lifecycle);
    expect((yield* Fiber.join(command))._tag).toBe("Failure");
    expect(requests.filter((url) => url.endsWith("/rpc"))).toHaveLength(0);
  }).pipe(Effect.scoped),
);

it.effect("shutdown finishes before a concurrent lifecycle drain and refresh", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const { service } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      {},
      undefined,
      undefined,
      Effect.void,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    );
    yield* service.configure({ enabled: true });
    const opened = yield* service.open({
      threadId: ThreadId.make("thread"),
      deviceId: "Pixel_API_35",
      platform: "android",
    });
    const shutdown = yield* asLifecycleAgent(service.shutdown(opened)).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const locked = yield* Deferred.make<void>();
    const lifecycle = yield* service
      .withLifecycleLock(
        Deferred.succeed(locked, undefined).pipe(
          Effect.andThen(service.control.invalidateHost("local")),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(locked);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(lifecycle);
    yield* Fiber.join(shutdown);
    expect((yield* service.control.state).every((state) => state.owner === null)).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect(
  "rotates grants while transferring one daemon session across hand-back, expiry, and runs",
  () =>
    Effect.gen(function* () {
      const grants: { token: string; session: string }[] = [];
      const { service, agentRequests } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        undefined,
        {},
        (_host, _ready, grant) =>
          Effect.sync(() => {
            if (grant) grants.push(grant);
            return `/config/${grant?.session ?? "host"}`;
          }),
      );
      yield* service.configure({ enabled: true, agentAccessEnabled: true });
      const opened = yield* service.open({
        threadId: ThreadId.make("thread"),
        deviceId: "Pixel_API_35",
        platform: "android",
      });
      const owner = { kind: "viewer" as const, sessionId: "session", viewerId: "viewer" };
      const command = (grant: { token: string; session: string }) =>
        service.agentCommand(grant.token, {
          jsonrpc: "2.0",
          id: "open",
          method: "agent_device.command",
          params: {
            session: grant.session,
            command: "open",
            flags: { platform: "android", serial: opened.deviceId },
          },
        });
      for (const transition of ["initial", "hand-back", "expiry", "new-run"]) {
        if (transition === "hand-back") {
          const held = yield* service.control.acquire(opened, owner);
          yield* service.control.release({ ...opened, owner, generation: held.generation });
        } else if (transition === "expiry") {
          yield* TestClock.adjust(DEVICE_CONTROL_TTL);
          expect((yield* service.control.state)[0]?.owner).toBeNull();
        } else if (transition === "new-run") {
          yield* service.control.stopRun(opened.threadId, "run");
        }
        const previous = grants.at(-1);
        yield* service.agentTarget({
          ...opened,
          runId: RunId.make(transition === "new-run" ? "next-run" : "run"),
        });
        if (previous) expect((yield* command(previous).pipe(Effect.result))._tag).toBe("Failure");
        yield* command(grants.at(-1)!);
      }
      expect(new Set(grants.map((grant) => grant.token)).size).toBe(4);
      expect(new Set(grants.map((grant) => grant.session)).size).toBe(4);
      expect(new Set(agentRequests.map((request) => request.params.session)).size).toBe(1);
      expect(grants.map((grant) => grant.session)).not.toContain(agentRequests[0]!.params.session);
    }).pipe(Effect.scoped),
);

it.effect("agent-only recovery reaches every device and reports remaining hub uncertainty", () =>
  Effect.gen(function* () {
    const agentStopping = yield* Deferred.make<void>();
    const agentStopped = yield* Deferred.make<void>();
    const hubStopping = yield* Deferred.make<void>();
    const hubStopped = yield* Deferred.make<void>();
    const restarted: ReadonlyArray<"hub" | "agent">[] = [];
    const { service } = yield* fixture(Effect.void, undefined, false, undefined, false, undefined, {
      restartTools: (tools) =>
        Effect.gen(function* () {
          restarted.push(tools);
          const agentOnly = tools.length === 1 && tools[0] === "agent";
          yield* Deferred.succeed(agentOnly ? agentStopping : hubStopping, undefined);
          yield* Deferred.await(agentOnly ? agentStopped : hubStopped);
          return {
            nodePath: process.execPath,
            hub: { origin: "http://device.test" },
            helpers: { serveSimAxSettings: null, serveSimCli: null },
            run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
          };
        }),
    });
    yield* service.configure({ enabled: true, agentAccessEnabled: true });
    const first = { hostId: "local", deviceId: "first" };
    const second = { hostId: "local", deviceId: "second" };
    const owner = { kind: "viewer" as const, sessionId: "session", viewerId: "viewer" };
    yield* service.control.acquire(first, owner);
    yield* service.control.acquire(second, {
      kind: "agent",
      threadId: ThreadId.make("thread"),
      runId: RunId.make("run"),
    });
    yield* service.control.uncertain(first, "hub");
    yield* service.control.uncertain(second, "agent");

    const agentRestart = yield* service
      .restartTools({ tools: ["agent"] })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(agentStopping);
    expect((yield* service.control.acquire(second, owner).pipe(Effect.flip)).code).toBe(
      "control_draining",
    );
    yield* Deferred.succeed(agentStopped, undefined);
    const result = yield* Fiber.join(agentRestart);
    expect((yield* service.control.acquire(second, owner)).phase).toBe("held");
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DeviceControlError", ...first, code: "input_unconfirmed" },
    });
    expect((yield* service.control.acquire(first, owner).pipe(Effect.flip)).code).toBe(
      "input_unconfirmed",
    );

    const hubRestart = yield* service
      .restartTools({ tools: ["hub"] })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(hubStopping);
    expect((yield* service.control.acquire(first, owner).pipe(Effect.flip)).code).toBe(
      "control_draining",
    );
    yield* Deferred.succeed(hubStopped, undefined);
    expect((yield* Fiber.join(hubRestart))._tag).toBe("Success");
    expect((yield* service.control.acquire(first, owner)).phase).toBe("held");
    expect(restarted).toEqual([["agent"], ["hub"]]);
  }).pipe(Effect.scoped),
);

for (const recovery of ["restart", "restart-failed", "disable", "stop", "deadline"] as const) {
  it.effect(
    `${recovery} recovers from a command whose response never completes without granting uncertain control`,
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const terminated = yield* Deferred.make<void>();
        const stopping = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        let grant: { token: string; session: string } | undefined;
        const stop = Deferred.succeed(stopping, undefined).pipe(
          Effect.andThen(Deferred.await(stopped)),
        );
        const { service } = yield* fixture(
          Effect.void,
          undefined,
          false,
          undefined,
          false,
          undefined,
          {
            stop,
            restartTools: () =>
              stop.pipe(
                Effect.andThen(
                  recovery === "restart-failed"
                    ? Effect.fail(
                        new DeviceHost.DeviceHostError({
                          hostId: "local",
                          step: "stop",
                          cause: new Error("Termination was not confirmed"),
                        }),
                      )
                    : Effect.succeed({
                        nodePath: process.execPath,
                        hub: { origin: "http://device.test" },
                        helpers: { serveSimAxSettings: null, serveSimCli: null },
                        run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
                      }),
                ),
              ),
          },
          (_host, _ready, value) =>
            Effect.sync(() => {
              grant = value;
              return "/config";
            }),
          undefined,
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(terminated, undefined)),
          ),
        );
        yield* service.configure({ enabled: true, agentAccessEnabled: true });
        const opened = yield* service.open({
          threadId: ThreadId.make("thread"),
          deviceId: "Pixel_API_35",
          platform: "android",
        });
        yield* service.agentTarget({ ...opened, runId: RunId.make("run") });
        const command = yield* service
          .agentCommand(grant!.token, {
            jsonrpc: "2.0",
            id: "stalled",
            method: "agent_device.command",
            params: {
              session: grant!.session,
              command: "click",
              flags: { platform: "android", serial: opened.deviceId },
            },
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        const owner = { kind: "viewer" as const, sessionId: "session", viewerId: "viewer" };
        if (recovery === "deadline" || recovery === "stop") {
          const stop =
            recovery === "stop"
              ? yield* service.control
                  .stopRun(opened.threadId, "run")
                  .pipe(Effect.forkChild({ startImmediately: true }))
              : undefined;
          yield* TestClock.adjust(DEVICE_CONTROL_CALL_TIMEOUT);
          if (stop) yield* Fiber.join(stop);
          yield* Deferred.await(terminated);
          expect((yield* Fiber.join(command))._tag).toBe("Failure");
          expect((yield* service.control.acquire(opened, owner).pipe(Effect.flip)).code).toBe(
            "input_unconfirmed",
          );
        } else {
          // Begin the ordinary drain first: explicit recovery must get past that waiter.
          const changes = yield* service.subscribe;
          const draining = yield* Stream.fromSubscription(changes).pipe(
            Stream.filter(
              (state) => state.controls?.some((control) => control.phase === "draining") ?? false,
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          const takeover = yield* service.control
            .acquire(opened, owner)
            .pipe(Effect.result, Effect.forkChild);
          yield* Fiber.join(draining);
          const recovering = yield* (
            recovery.startsWith("restart")
              ? service.restartTools({ tools: ["agent"] })
              : service.configure({ enabled: false })
          ).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(stopping);
          yield* Deferred.await(terminated);
          expect((yield* Fiber.join(command))._tag).toBe("Failure");
          expect((yield* Fiber.join(takeover))._tag).toBe("Failure");
          expect((yield* service.control.acquire(opened, owner).pipe(Effect.flip)).code).toBe(
            "control_draining",
          );
          yield* Deferred.succeed(stopped, undefined);
          expect((yield* Fiber.join(recovering))._tag).toBe(
            recovery === "restart-failed" ? "Failure" : "Success",
          );
          if (recovery === "restart")
            expect((yield* service.control.acquire(opened, owner)).phase).toBe("held");
          else
            expect((yield* service.control.acquire(opened, owner).pipe(Effect.flip)).code).toBe(
              "input_unconfirmed",
            );
        }
      }).pipe(Effect.scoped),
  );
}

describe("DeviceService.installPlatform", () => {
  const waitFor = (
    changes: PubSub.Subscription<DeviceServiceState>,
    predicate: (state: DeviceServiceState) => boolean,
  ): Effect.Effect<DeviceServiceState> =>
    PubSub.take(changes).pipe(
      Effect.flatMap((state) =>
        predicate(state) ? Effect.succeed(state) : waitFor(changes, predicate),
      ),
    );

  it.effect("returns at once and publishes progress until the install finishes", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      let installs = 0;
      const { service } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        undefined,
        {
          installAndroid: (onProgress) =>
            Effect.gen(function* () {
              installs++;
              yield* onProgress("Downloading the Android Emulator…");
              yield* Deferred.await(finish);
              return false;
            }),
        },
      );
      const changes = yield* service.subscribe;
      const started = yield* service.installPlatform({ platform: "android" });
      expect(started.platformInstalls).toEqual([
        {
          hostId: LOCAL_DEVICE_HOST_ID,
          platform: "android",
          status: "installing",
          detail: "Preparing Android setup…",
        },
      ]);
      yield* waitFor(
        changes,
        (state) => state.platformInstalls?.[0]?.detail === "Downloading the Android Emulator…",
      );
      // A second click or client joins the running install instead of starting another.
      yield* service.installPlatform({ platform: "android" });
      yield* Deferred.succeed(finish, undefined);
      yield* waitFor(changes, (state) => state.platformInstalls?.length === 0);
      expect(installs).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a failed install visible with its reason and allows a retry", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const { service } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        undefined,
        {
          installAndroid: () =>
            Effect.suspend(() =>
              ++attempts === 1
                ? Effect.fail(new AndroidSdkInstallError({ reason: "Couldn't download." }))
                : Effect.succeed(false),
            ),
        },
      );
      const changes = yield* service.subscribe;
      yield* service.installPlatform({ platform: "android" });
      const failed = yield* waitFor(
        changes,
        (state) => state.platformInstalls?.[0]?.status === "failed",
      );
      expect(failed.platformInstalls?.[0]?.detail).toBe("Couldn't download.");
      yield* service.installPlatform({ platform: "android" });
      yield* waitFor(changes, (state) => state.platformInstalls?.length === 0);
      expect(attempts).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects hosts that cannot install Android", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      const error = yield* service.installPlatform({ platform: "android" }).pipe(Effect.flip);
      expect(error._tag).toBe("DeviceHostUnavailableError");
    }).pipe(Effect.scoped),
  );
});
