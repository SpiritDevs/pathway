// @effect-diagnostics preferSchemaOverJson:off - the external process fixture emits raw JSON over SSH stdout.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Net from "@spiritdevs/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as SshDeviceHost from "./SshDeviceHost.ts";

it.effect("preserves installed status after probes and cleans failed agent activation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const modes: string[] = [];
    const owners: string[] = [];
    let forwards = 0;
    let guardians = 0;
    let failForward = true;
    let rejectConfig = true;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
        const guardian = command.args.includes("-T");
        const forwarding = guardian || command.args.includes("-N");
        let output = "";
        if (forwarding) {
          if (failForward) {
            failForward = false;
            return yield* PlatformError.systemError({
              _tag: "AlreadyExists",
              module: "ChildProcess",
              method: "spawn",
              description: "Port already bound",
            });
          }
          forwards++;
          if (guardian) guardians++;
          output = "ready\n";
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              forwards--;
              if (guardian) guardians--;
            }),
          );
        } else {
          const stdin = command.options.stdin;
          if (
            !stdin ||
            typeof stdin !== "object" ||
            !("stream" in stdin) ||
            !Stream.isStream(stdin.stream)
          )
            return yield* Effect.die("Missing script");
          const script = yield* stdin.stream.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (a, b) => a + b,
            ),
          );
          const mode = /const mode = "([^"]+)"/.exec(script)?.[1] ?? "";
          modes.push(mode);
          owners.push(/const owner = "([^"]+)"/.exec(script)?.[1] ?? "");
          output = JSON.stringify({
            nodePath: "/node",
            platforms: [{ platform: "ios", available: true }],
            hubPort: 1234,
            helpers: { serveSimAxSettings: null, serveSimCli: null },
            ...(mode === "agent-start" || mode.startsWith("restart-")
              ? { daemonPort: 1235, token: "fixture", entryPath: "/agent.mjs" }
              : {}),
          });
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.make(new TextEncoder().encode(output)),
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: forwarding ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(forwarding),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const host = yield* SshDeviceHost.make(
      { id: "test", label: "Test", target: "test.example" },
      () =>
        rejectConfig
          ? Effect.fail(
              new DeviceHost.DeviceHostError({
                hostId: "test",
                step: "configuring agent access",
                cause: new Error("fixture failure"),
              }),
            )
          : Effect.void,
    ).pipe(
      Effect.provide(Layer.mergeAll(ServerConfig.layerTest(home, home), Net.layer)),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
        ),
      ),
    );
    yield* host.ensureReady(() => Effect.void);
    yield* SshDeviceHost.probe({ id: "test", label: "Test", target: "test.example" }).pipe(
      Effect.provide(ServerConfig.layerTest(home, home)),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    expect(new Set(owners).size).toBe(2);
    expect(owners[0]).toMatch(/^[a-f0-9]{24}-[a-f0-9-]{36}$/);
    expect(forwards).toBe(1);
    expect(modes.filter((mode) => mode === "start")).toHaveLength(2);
    yield* host.platformAvailability("ios");
    expect((yield* host.summary).hubInstalled).toBe(true);
    const failed = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.result);
    expect(failed._tag).toBe("Failure");
    expect(forwards).toBe(0);
    expect(modes.at(-1)).toBe("stop-agent");
    expect(yield* host.current).toBeNull();
    rejectConfig = false;
    yield* host.ensureAgentReady(() => Effect.void);
    yield* host.platformAvailability("ios");
    expect((yield* host.summary).agentDeviceInstalled).toBe(true);
    for (const tools of [["hub"], ["agent"], ["hub", "agent"]] as const) {
      const before = modes.length;
      yield* host.restartTools!(tools);
      expect(guardians).toBe(1);
      expect(forwards).toBe(2);
      expect(modes.slice(before)).toEqual([
        tools.length === 2 ? "restart-tools" : `restart-${tools[0]}`,
      ]);
      expect(yield* host.current).not.toBeNull();
    }
    yield* host.stopAgent;
    expect(forwards).toBe(1);
    yield* host.stop;
    expect(forwards).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
