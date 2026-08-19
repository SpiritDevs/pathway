import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  macDeviceKind,
  parseMacHardwareProfile,
  resolveServerEnvironmentDevice,
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
