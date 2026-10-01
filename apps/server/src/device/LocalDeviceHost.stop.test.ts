// @effect-diagnostics nodeBuiltinImport:off - uses a spawned stand-in daemon to verify delayed exit after host.stop.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
// @effect-diagnostics preferSchemaOverJson:off - fixture daemon writes its external JSON state.
import { HostProcessIsExecutable } from "./nodeRuntime.ts";
import { expect, it } from "@effect/vitest";
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

it.effect("relinquishes local ownership after a slow helper exits following host.stop", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-restart-" });
    const cache = path.join(base, "cache");
    const helper = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          ["-e", "process.stdin.resume(); console.log('ready')"],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        await NodeEvents.EventEmitter.once(child.stdout, "data");
        return child;
      }),
      (child) =>
        Effect.promise(async () => {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = NodeEvents.EventEmitter.once(child, "exit");
            child.kill();
            await exited;
          }
        }),
    );
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
                JSON.stringify({
                  httpPort: 5000 + agentStarts,
                  token: `token-${agentStarts}`,
                  pid: helper.pid,
                }),
              );
            }
            if (input.args.includes("stop")) {
              agentStops++;
              // The stop command returned, but the spawned daemon has not exited yet.
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
    yield* host.ensureAgentReady(() => Effect.void);
    yield* host.acquireDevice("ios:phone");
    const competitor = makeDeviceLeases(cache, {
      environmentId: "other",
      environmentLabel: "Other",
    });
    yield* host.stop;
    expect(yield* host.current).toBeNull();
    expect(agentStops).toBe(1);
    expect(yield* Effect.promise(() => competitor.acquire("ios:phone"))).not.toBeNull();
    yield* Effect.promise(async () => {
      const exited = NodeEvents.EventEmitter.once(helper, "exit");
      helper.stdin.end();
      await exited;
    });
    // Correct behavior: stopping device support must release once its final helper exits.
    expect(yield* Effect.promise(() => competitor.acquire("ios:phone"))).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
