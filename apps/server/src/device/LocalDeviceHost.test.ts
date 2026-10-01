// @effect-diagnostics preferSchemaOverJson:off - fixture daemon writes its external JSON state.
import { HostProcessIsExecutable } from "./nodeRuntime.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { makeDeviceLeases } from "./DeviceLeases.ts";
import { DEVICE_HUB_VERSION, AGENT_DEVICE_VERSION } from "./DeviceToolchain.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as NetService from "@spiritdevs/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const diagnose = (
  files: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = "darwin",
) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcessEnvironment, environment),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(platform === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
  );

describe("Android SDK availability", () => {
  it.effect("explains that adb alone is insufficient to launch an emulator", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb"], { ANDROID_HOME: "/sdk" });
      expect(reason).toContain("Android Emulator is missing");
    }),
  );

  it.effect("identifies command-line tools required by the device hub", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb", "/sdk/emulator/emulator"], {
        ANDROID_HOME: "/sdk",
      });
      expect(reason).toContain("Command-line Tools (latest) are missing");
    }),
  );

  it.effect("explains how to upgrade legacy command-line tools in the standard macOS SDK", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [`${root}/platform-tools/adb`, `${root}/emulator/emulator`, `${root}/tools/bin/avdmanager`],
        { HOME: "/test/home" },
      );
      expect(reason).toContain("older, unsupported version");
      expect(reason).toContain(root);
      expect(reason).toContain(
        "Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.",
      );
    }),
  );

  it.effect("recognizes legacy command-line tools on Windows", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "C:\\Android\\Sdk\\platform-tools\\adb.exe",
          "C:\\Android\\Sdk\\emulator\\emulator.exe",
          "C:\\Android\\Sdk\\tools\\bin\\avdmanager.bat",
        ],
        { ANDROID_HOME: "C:\\Android\\Sdk" },
        "win32",
      );
      expect(reason).toContain("older, unsupported version");
    }),
  );

  it.effect("accepts the latest command-line tools when legacy tools are also installed", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "/sdk/platform-tools/adb",
          "/sdk/emulator/emulator",
          "/sdk/tools/bin/avdmanager",
          "/sdk/cmdline-tools/latest/bin/avdmanager",
        ],
        { ANDROID_HOME: "/sdk" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("discovers the standard macOS SDK without ANDROID_HOME", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [
          `${root}/platform-tools/adb`,
          `${root}/emulator/emulator`,
          `${root}/cmdline-tools/latest/bin/avdmanager`,
        ],
        { HOME: "/test/home" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("reports an absent SDK without running or installing tools", () =>
    Effect.gen(function* () {
      expect(yield* diagnose([], { HOME: "/test/home" })).toContain("Android SDK was not found");
    }),
  );
});

it.effect("puts detected Android tools on the helper PATH without losing existing commands", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const environment = LocalDeviceHost.__testing.deviceHostEnvironment(
      { PATH: "/usr/bin", HOME: "/test/home" },
      "/sdk",
      "darwin",
      path,
    );
    expect(environment.PATH).toBe("/sdk/platform-tools:/sdk/emulator:/usr/bin");
    expect(environment.ANDROID_HOME).toBe("/sdk");
    expect(environment.HOME).toBe("/test/home");
  }).pipe(Effect.provide(NodePath.layer)),
);

it.effect(
  "constructs and inspects an unconfigured host without installing or starting helpers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-consent-" });
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
        Effect.provideService(HostProcessEnvironment, { HOME: baseDir, PATH: "" }),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die(new Error("Host construction must not spawn processes")),
          ),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die(new Error("Host construction must not run commands")),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("Host construction must not make network requests")),
          ),
        ),
      );
      expect(yield* host.current).toBeNull();
      const error = yield* host
        .ensureReady(() => Effect.die("Must not install without Node"))
        .pipe(Effect.flip, Effect.provideService(HostProcessIsExecutable, true));
      expect(error.message).toContain("Local device support requires Node.js");
      expect(error.message).toContain("Install Node.js");
      yield* host.stop;
      expect(yield* fs.exists(`${baseDir}/tools`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("restarts only selected local helpers and retains leases throughout", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-restart-" });
    const cache = path.join(base, "cache");
    const hubStops: number[] = [];
    let hubStarts = 0;
    let agentStarts = 0;
    let agentStops = 0;
    for (const [name, version, entry] of [
      ["expo-device-hub", DEVICE_HUB_VERSION, "dist/server/cli.mjs"],
      ["agent-device", AGENT_DEVICE_VERSION, "bin/agent-device.mjs"],
    ]) {
      const directory = path.join(cache, "tools", name!, version!);
      const file = path.join(directory, "node_modules", name!, entry!);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, "fixture");
      yield* fs.writeFileString(path.join(directory, ".install-complete"), version!);
    }
    const host = yield* LocalDeviceHost.make().pipe(
      Effect.provide(Layer.mergeAll(ServerConfig.layerTest(base, base), NetService.layer)),
      Effect.provideService(HostProcessEnvironment, {
        HOME: base,
        PATH: "",
        PATHWAY_DEVICE_CACHE_DIR: cache,
      }),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessIsExecutable, false),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const pid = ++hubStarts;
            const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            let running = true;
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                running = false;
                hubStops.push(pid);
                yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
              }),
            );
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(900000 + pid),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: Deferred.await(exit),
              isRunning: Effect.sync(() => running),
              kill: () => Effect.void,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }),
        ),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.gen(function* () {
            if (input.args.includes("devices")) {
              agentStarts++;
              yield* fs.writeFileString(
                path.join(input.env!.AGENT_DEVICE_STATE_DIR!, "daemon.json"),
                JSON.stringify({ httpPort: 5000 + agentStarts, token: `token-${agentStarts}` }),
              );
            }
            if (input.args.includes("stop")) {
              agentStops++;
              yield* fs.remove(
                path.join(input.args[input.args.indexOf("--state-dir") + 1]!, "daemon.json"),
                { force: true },
              );
            }
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.orDie),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
        ),
      ),
    );
    expect(yield* host.restartTools!(["hub", "agent"])).toBeNull();
    const original = yield* host.ensureAgentReady(() => Effect.void);
    yield* host.acquireDevice("ios:phone");
    const competitor = makeDeviceLeases(cache, {
      environmentId: "other",
      environmentLabel: "Other",
    });
    const hubOnly = yield* host.restartTools!(["hub"]);
    expect(hubOnly?.hub.origin).not.toBe(original.hub.origin);
    expect(hubOnly?.agentDevice).toEqual(original.agentDevice);
    expect([hubStarts, agentStarts, agentStops]).toEqual([2, 1, 0]);
    expect(yield* Effect.promise(() => competitor.acquire("ios:phone"))).not.toBeNull();
    const agentOnly = yield* host.restartTools!(["agent"]);
    expect(agentOnly?.hub).toEqual(hubOnly?.hub);
    expect(agentOnly?.agentDevice).not.toEqual(original.agentDevice);
    expect([hubStarts, agentStarts, agentStops]).toEqual([2, 2, 1]);
    yield* host.restartTools!(["hub", "agent"]);
    expect([hubStarts, agentStarts, agentStops]).toEqual([3, 3, 2]);
    expect(hubStops).toEqual([1, 2]);
    expect(yield* Effect.promise(() => competitor.acquire("ios:phone"))).not.toBeNull();
    yield* host.stop;
    expect(yield* Effect.promise(() => competitor.acquire("ios:phone"))).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
