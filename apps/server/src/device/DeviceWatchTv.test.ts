// @effect-diagnostics preferSchemaOverJson:off - JSON represents the external simctl/helper fixture boundary.
import { expect, it } from "@effect/vitest";
import {
  LOCAL_DEVICE_HOST_ID,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type DeviceFamily,
  type DeviceInput,
  type DeviceSummary,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { DeviceHost, type DeviceHostReady } from "./DeviceHost.ts";
import { DeviceControlCaller } from "./DeviceControl.ts";
import { type DeviceService, makeWithHosts } from "./DeviceService.ts";

const fixture = Effect.fn("watchTvFixture")(function* () {
  const commands: { host: string; args: ReadonlyArray<string> }[] = [];
  const requests: string[] = [];
  const inputs: { origin: string; id: string; input: DeviceInput }[] = [];
  const claims: string[] = [];
  const paired = new Map<string, string>();
  const booted = new Set<string>();
  let blocked: string | null = null;
  let pairFailure = false;
  let attachFailure = false;
  const families: DeviceFamily[] = ["phone", "pad", "watch", "tv"];
  const devices = (host: string): DeviceSummary[] =>
    families.map((family) => ({
      hostId: host,
      id: family,
      name: `Renamed ${family}`,
      family,
      platform: "ios",
      version: family === "watch" ? "watchOS 27.0" : family === "tv" ? "tvOS 27.0" : "iOS 27.0",
      booted: booted.has(`${host}:${family}`),
      physical: false,
    }));
  const hosts = ["local", "ssh-mac"].map((id): DeviceHost["Service"] => {
    const ready: DeviceHostReady = {
      nodePath: "/host/node",
      hub: { origin: `http://${id}.test` },
      helpers: { serveSimCli: null, serveSimAxSettings: null },
      run: (_command, args) =>
        Effect.sync(() => {
          commands.push({ host: id, args });
          if (args[1] === "list")
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                pairs: paired.has(id)
                  ? {
                      pair1: {
                        watch: { udid: "watch" },
                        phone: { udid: paired.get(id) },
                        state: "(active, disconnected)",
                      },
                    }
                  : {},
              }),
            };
          if (args[1] === "pair") {
            if (pairFailure) return { code: 1, stderr: "incompatible runtimes", stdout: "" };
            paired.set(id, args[3]!);
          }
          if (args[1] === "unpair") paired.delete(id);
          return { code: 0, stderr: "", stdout: "" };
        }),
    };
    return {
      id,
      summary: Effect.succeed({
        id,
        kind: id === "local" ? "local" : "ssh",
        label: id,
        platforms: [{ platform: "ios", available: true }],
        hubInstalled: true,
        agentDeviceInstalled: true,
      }),
      platformAvailability: (platform) =>
        Effect.succeed({ platform, available: platform === "ios" }),
      ensureReady: () => Effect.succeed(ready),
      ensureAgentReady: () =>
        Effect.succeed({
          ...ready,
          agentDevice: { baseUrl: "http://agent.test", token: "test", entryPath: "/agent" },
        }),
      current: Effect.succeed(ready),
      stop: Effect.void,
      stopAgent: Effect.void,
      acquireDevice: (key) =>
        Effect.sync(() => {
          claims.push(`${id}:${key}`);
          return blocked === `${id}:${key}`
            ? { environmentId: "other", environmentLabel: "Other environment" }
            : null;
        }),
      deviceOwners: () => Effect.succeed({}),
    };
  });
  const service = yield* makeWithHosts(
    new Map(hosts.map((host) => [host.id, host])),
    undefined,
    undefined,
    undefined,
    undefined,
    (ready, id, input) =>
      Effect.sync(() => {
        inputs.push({ origin: ready.hub.origin, id, input });
      }),
  ).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          const host = new URL(request.url).hostname.replace(".test", "");
          if (request.url.endsWith("/api/devices"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ simulators: devices(host), emulators: [] }),
            );
          if (request.url.endsWith("/api/devices/boot")) {
            // The JSON body is opaque to the mock; both tested targets become booted after hub boot.
            booted.add(`${host}:watch`);
            booted.add(`${host}:tv`);
          }
          if (request.url.endsWith("/grid/api/start") && attachFailure)
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ ok: false, error: "capture failed" }),
            );
          if (request.url.includes("/api/screenshot"))
            return HttpClientResponse.fromWeb(
              request,
              new Response(new Uint8Array([137, 80, 78, 71])),
            );
          return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
        }),
      ),
    ),
  );
  return {
    service,
    commands,
    requests,
    inputs,
    claims,
    paired,
    block: (key: string) => {
      blocked = key;
    },
    failPair: () => {
      pairFailure = true;
    },
    failAttach: () => {
      attachFailure = true;
    },
  };
});
const settings = ServerSettingsService.of({
  start: Effect.void,
  ready: Effect.void,
  getSettings: Effect.succeed({
    ...DEFAULT_SERVER_SETTINGS,
    enableDeviceSupport: true,
    enableAgentDeviceAccess: true,
  }),
  updateSettings: () => Effect.die("not used"),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.succeed(Stream.empty),
});
const test = <E>(body: (f: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    yield* body(yield* fixture());
  }).pipe(Effect.provideService(ServerSettingsService, settings), Effect.scoped);

const viewer = { kind: "viewer" as const, sessionId: "session" };

/** Device actions need a held viewer lease since device control. */
const controlledAction = (
  service: DeviceService["Service"],
  input: Parameters<DeviceService["Service"]["action"]>[0],
) =>
  Effect.gen(function* () {
    const held = yield* service.control.acquire(
      { hostId: input.hostId ?? LOCAL_DEVICE_HOST_ID, deviceId: input.deviceId },
      { ...viewer, viewerId: "viewer" },
    );
    return yield* service
      .action({ ...input, control: { viewerId: "viewer", generation: held.generation } })
      .pipe(Effect.provideService(DeviceControlCaller, viewer));
  });

it.effect("discovers all families and emits UI capabilities without leaking origins", () =>
  test((f) =>
    Effect.gen(function* () {
      const state = yield* f.service.list;
      expect(state.devices).toHaveLength(8);
      expect(
        state.devices
          .filter((device) => device.family === "tv")
          .map((device) => device.capabilities?.inputKinds),
      ).toEqual([["remoteButton"], ["remoteButton"]]);
      expect(
        state.devices.find((device) => device.family === "watch")?.capabilities?.agentCli.status,
      ).toBe("unsupported");
      expect(state.devices.find((device) => device.family === "watch")?.watchPair).toBeNull();
      expect(JSON.stringify(state)).not.toContain(".test");
    }),
  ),
);

it.effect(
  "boots and attaches Watch and TV on the selected SSH host, screenshots and closes them",
  () =>
    test((f) =>
      Effect.gen(function* () {
        for (const deviceId of ["watch", "tv"]) {
          const session = yield* f.service.open({
            threadId: ThreadId.make("thread"),
            hostId: "ssh-mac",
            deviceId,
            platform: "ios",
          });
          expect(session.hostId).toBe("ssh-mac");
          const capture = yield* f.service.screenshot({ hostId: "ssh-mac", deviceId });
          expect(capture.device.family).toBe(deviceId);
          yield* f.service.close({
            threadId: ThreadId.make("thread"),
            hostId: "ssh-mac",
            deviceId,
          });
        }
        expect(f.requests.filter((url) => url.includes("/grid/api/start"))).toEqual([
          "http://ssh-mac.test/vendor/serve-sim/grid/api/start",
          "http://ssh-mac.test/vendor/serve-sim/grid/api/start",
        ]);
        expect((yield* f.service.state).sessions).toHaveLength(0);
      }),
    ),
);

it.effect("rejects native stream attachment failures before registering a session", () =>
  test((f) =>
    Effect.gen(function* () {
      f.failAttach();
      const error = yield* f.service
        .open({ threadId: ThreadId.make("thread"), deviceId: "tv", platform: "ios" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("DeviceOperationError");
      expect((yield* f.service.state).sessions).toHaveLength(0);
    }),
  ),
);

it.effect(
  "pairs an explicit same-host iPhone idempotently and unpairs without booting either",
  () =>
    test((f) =>
      Effect.gen(function* () {
        for (let i = 0; i < 2; i++)
          yield* controlledAction(f.service, {
            hostId: "ssh-mac",
            deviceId: "watch",
            type: "pairWatch",
            phoneDeviceId: "phone",
          });
        expect(f.commands.filter((call) => call.args[1] === "pair")).toEqual([
          { host: "ssh-mac", args: ["simctl", "pair", "watch", "phone"] },
        ]);
        expect(
          (yield* f.service.detail({ hostId: "ssh-mac", deviceId: "watch" })).watchPair
            ?.phoneDeviceId,
        ).toBe("phone");
        yield* controlledAction(f.service, {
          hostId: "ssh-mac",
          deviceId: "watch",
          type: "unpairWatch",
        });
        expect(
          (yield* f.service.detail({ hostId: "ssh-mac", deviceId: "watch" })).watchPair,
        ).toBeNull();
        expect(f.requests.some((url) => /boot|start/.test(url))).toBe(false);
        expect(f.commands.find((call) => call.args[1] === "unpair")?.args).toEqual([
          "simctl",
          "unpair",
          "pair1",
        ]);
      }),
    ),
);

it.effect(
  "rejects iPads and absent companions, runtime mismatch and another environment's phone lease",
  () =>
    test((f) =>
      Effect.gen(function* () {
        for (const phoneDeviceId of ["pad", "absent"]) {
          const error = yield* controlledAction(f.service, {
            deviceId: "watch",
            type: "pairWatch",
            phoneDeviceId,
          }).pipe(Effect.flip);
          expect(error._tag).toBe("DeviceActionUnavailableError");
        }
        f.failPair();
        expect(
          (yield* controlledAction(f.service, {
            deviceId: "watch",
            type: "pairWatch",
            phoneDeviceId: "phone",
          }).pipe(Effect.flip))._tag,
        ).toBe("DeviceOperationError");
        const before = f.commands.length;
        f.block("local:ios:phone");
        expect(
          (yield* controlledAction(f.service, {
            deviceId: "watch",
            type: "pairWatch",
            phoneDeviceId: "phone",
          }).pipe(Effect.flip))._tag,
        ).toBe("DeviceHostUnavailableError");
        expect(f.commands.slice(before).some((call) => call.args[1] === "pair")).toBe(false);
      }),
    ),
);

it.effect("routes crown and Siri input to the host and rejects cross-family controls", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.service.open({
        threadId: ThreadId.make("thread"),
        hostId: "ssh-mac",
        deviceId: "watch",
        platform: "ios",
      });
      yield* f.service.input({
        hostId: "ssh-mac",
        deviceId: "watch",
        input: { kind: "digitalCrown", delta: -10 },
      });
      yield* f.service.input({
        hostId: "ssh-mac",
        deviceId: "tv",
        input: { kind: "remoteButton", button: "playPause" },
      });
      expect(f.inputs.map((input) => input.origin)).toEqual([
        "http://ssh-mac.test",
        "http://ssh-mac.test",
      ]);
      for (const [deviceId, input] of [
        ["tv", { kind: "touch", phase: "begin", x: 0.5, y: 0.5 }],
        ["watch", { kind: "remoteButton", button: "home" }],
      ] as const) {
        expect(
          (yield* f.service.input({ hostId: "ssh-mac", deviceId, input }).pipe(Effect.flip))._tag,
        ).toBe("DeviceOperationError");
      }
      expect(f.inputs).toHaveLength(2);
    }),
  ),
);

it.effect("serializes pairing from simultaneous callers and pairs before Watch boot", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* Effect.all(
        [
          controlledAction(f.service, {
            hostId: "ssh-mac",
            deviceId: "watch",
            type: "pairWatch",
            phoneDeviceId: "phone",
          }),
          f.service.open({
            threadId: ThreadId.make("thread"),
            hostId: "ssh-mac",
            deviceId: "watch",
            platform: "ios",
            companionDeviceId: "phone",
          }),
        ],
        { concurrency: 2 },
      );
      expect(f.commands.filter((call) => call.args[1] === "pair")).toHaveLength(1);
      expect(
        (yield* f.service.state).devices.find(
          (device) => device.hostId === "ssh-mac" && device.id === "watch",
        )?.watchPair?.phoneDeviceId,
      ).toBe("phone");
    }),
  ),
);

it.effect("refuses input on a stopped target and respects another environment's ownership", () =>
  test((f) =>
    Effect.gen(function* () {
      expect(
        (yield* f.service
          .input({ deviceId: "watch", input: { kind: "watchButton", button: "side" } })
          .pipe(Effect.flip))._tag,
      ).toBe("DeviceOperationError");
      yield* f.service.open({
        threadId: ThreadId.make("thread"),
        deviceId: "watch",
        platform: "ios",
      });
      yield* f.service.input({ deviceId: "watch", input: { kind: "watchButton", button: "side" } });
      f.block("local:ios:watch");
      expect(
        (yield* f.service
          .input({ deviceId: "watch", input: { kind: "watchButton", button: "crown" } })
          .pipe(Effect.flip))._tag,
      ).toBe("DeviceHostUnavailableError");
      expect(f.inputs).toHaveLength(1);
    }),
  ),
);

it.effect(
  "unpairs an unavailable companion without bypassing its environment lease, then pairs a replacement",
  () =>
    test((f) =>
      Effect.gen(function* () {
        f.paired.set("ssh-mac", "unavailable-phone");
        f.block("ssh-mac:ios:unavailable-phone");
        expect(
          (yield* controlledAction(f.service, {
            hostId: "ssh-mac",
            deviceId: "watch",
            type: "unpairWatch",
          }).pipe(Effect.flip))._tag,
        ).toBe("DeviceHostUnavailableError");
        expect(f.commands.some((command) => command.args[1] === "unpair")).toBe(false);
        f.block("no-block");
        yield* controlledAction(f.service, {
          hostId: "ssh-mac",
          deviceId: "watch",
          type: "unpairWatch",
        });
        expect(f.claims).toContain("ssh-mac:ios:unavailable-phone");
        expect(f.commands.filter((command) => command.args[1] === "unpair")).toEqual([
          { host: "ssh-mac", args: ["simctl", "unpair", "pair1"] },
        ]);
        yield* controlledAction(f.service, {
          hostId: "ssh-mac",
          deviceId: "watch",
          type: "pairWatch",
          phoneDeviceId: "phone",
        });
        expect(f.paired.get("ssh-mac")).toBe("phone");
      }),
    ),
);
