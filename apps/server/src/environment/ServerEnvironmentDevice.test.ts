import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform, HostProcessArchitecture } from "@spiritdevs/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  macDeviceKind,
  parseMacHardwareProfile,
  resolveServerEnvironmentDevice,
  makeCachedServerEnvironmentDevice,
} from "./ServerEnvironmentDevice.ts";

const macProfile = JSON.stringify({
  SPHardwareDataType: [
    {
      machine_name: "MacBook Pro",
      machine_model: "MacBookPro17,1",
      serial_number: "must-not-leak",
      platform_UUID: "must-not-leak",
    },
  ],
});

describe("environment device metadata", () => {
  it("classifies common Mac models", () => {
    expect(macDeviceKind({ model: "MacBook Pro" })).toBe("laptop");
    expect(macDeviceKind({ model: "Mac Studio" })).toBe("desktop");
    expect(macDeviceKind({ model: "Mac mini" })).toBe("desktop");
    expect(macDeviceKind({ modelIdentifier: "UnknownMac1,1" })).toBe("unknown");
  });

  it("allow-lists display fields from the macOS hardware profile", () => {
    expect(parseMacHardwareProfile(macProfile, "dev-mac.local")).toEqual({
      kind: "laptop",
      hostname: "dev-mac.local",
      model: "MacBook Pro",
      modelIdentifier: "MacBookPro17,1",
    });
  });

  it.effect("collects the macOS profile once through the bounded probe", () => {
    const processRunner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          expect(input).toMatchObject({
            command: "system_profiler",
            args: ["SPHardwareDataType", "-json"],
            timeoutBehavior: "timedOutResult",
            outputMode: "truncate",
          });
          return {
            stdout: macProfile,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });

    return Effect.gen(function* () {
      expect(yield* resolveServerEnvironmentDevice("dev-mac.local")).toEqual({
        kind: "laptop",
        hostname: "dev-mac.local",
        model: "MacBook Pro",
        modelIdentifier: "MacBookPro17,1",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcessPlatform, "darwin"),
          Layer.succeed(ProcessRunner.ProcessRunner, processRunner),
        ),
      ),
    );
  });
});

it.effect(
  "serves fallback or cached hardware immediately and persists a successful background refresh",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-device-cache-" });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const runner = ProcessRunner.ProcessRunner.of({
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({
              stdout: macProfile,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
          ),
      });
      const first = yield* makeCachedServerEnvironmentDevice("dev-mac.local", stateDir).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      expect(yield* first.getDevice).toEqual({ kind: "unknown", hostname: "dev-mac.local" });
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first.refresh);
      expect((yield* first.getDevice).kind).toBe("laptop");
      const raw = yield* fs.readFileString(`${stateDir}/environment-device.json`);
      expect(raw).not.toContain("must-not-leak");
      const stalled = ProcessRunner.ProcessRunner.of({ run: () => Effect.never });
      const cached = yield* makeCachedServerEnvironmentDevice("dev-mac.local", stateDir).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, stalled),
      );
      expect((yield* cached.getDevice).model).toBe("MacBook Pro");
      const failed = yield* makeCachedServerEnvironmentDevice("dev-mac.local", stateDir).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: () =>
              Effect.succeed({
                stdout: "invalid-json",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
          }),
        ),
      );
      yield* Fiber.join(failed.refresh);
      expect((yield* failed.getDevice).model).toBe("MacBook Pro");
      expect(yield* fs.readFileString(`${stateDir}/environment-device.json`)).toBe(raw);
      const wrongArchitecture = yield* makeCachedServerEnvironmentDevice(
        "dev-mac.local",
        stateDir,
      ).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, stalled),
        Effect.provideService(
          HostProcessArchitecture,
          (yield* HostProcessArchitecture) === "arm64" ? "x64" : "arm64",
        ),
      );
      expect((yield* wrongArchitecture.getDevice).kind).toBe("unknown");
      const otherHost = yield* makeCachedServerEnvironmentDevice("other-host", stateDir).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, stalled),
      );
      expect(yield* otherHost.getDevice).toEqual({ kind: "unknown", hostname: "other-host" });
      yield* fs.writeFileString(`${stateDir}/environment-device.json`, "invalid-json");
      const corrupt = yield* makeCachedServerEnvironmentDevice("dev-mac.local", stateDir).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, stalled),
      );
      expect((yield* corrupt.getDevice).kind).toBe("unknown");
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provide(NodeServices.layer),
    ),
);
