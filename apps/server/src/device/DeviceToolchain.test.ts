import { HostProcessIsExecutable } from "./nodeRuntime.ts";
import { HostProcessExecutablePath, HostProcessEnvironment } from "@spiritdevs/shared/hostProcess";
import * as PlatformError from "effect/PlatformError";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  deviceToolVersions,
  DEVICE_HUB_VERSION,
  ensureDeviceHub,
  isDeviceHubInstalled,
} from "./DeviceToolchain.ts";

it.effect("failed installation cleans staging and exposes only a safe failure message", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const result = {
      code: ChildProcessSpawner.ExitCode(1),
      stdout: "",
      stderr: "registry rejected https://private:credential@example.test/package",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const error = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(result),
      }),
      Effect.flip,
    );
    expect(error.message).toBe(
      "Installing expo-device-hub failed while running npm install (exit code 1).",
    );
    expect(error.cause).toBe(result);
    expect(yield* isDeviceHubInstalled(baseDir)).toBe(false);
    expect(yield* fs.readDirectory(path.join(baseDir, "tools", "expo-device-hub"))).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("inventory reports only completed versions without installing the required version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    for (const [version, sentinel] of [
      ["0.9.0", "0.9.0"],
      [DEVICE_HUB_VERSION, "wrong"],
      [".staging-123", ".staging-123"],
    ]) {
      const dir = path.join(base, "tools", "expo-device-hub", version!);
      yield* fs.makeDirectory(path.join(dir, "node_modules/expo-device-hub/dist/server"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(dir, "node_modules/expo-device-hub/dist/server/cli.mjs"),
        "",
      );
      yield* fs.writeFileString(path.join(dir, ".install-complete"), sentinel!);
    }
    const tools = yield* deviceToolVersions(base);
    expect(tools?.hub).toEqual({
      requiredVersion: DEVICE_HUB_VERSION,
      installedVersions: ["0.9.0"],
      runningVersion: null,
    });
    expect(tools?.agent.installedVersions).toEqual([]);
    expect(yield* isDeviceHubInstalled(base)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("unreadable inventory stays unknown instead of reporting no installs", () =>
  Effect.gen(function* () {
    const tools = yield* deviceToolVersions("/unreadable");
    expect(tools).toBeUndefined();
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readDirectory: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readDirectory",
              description: "denied",
            }),
          ),
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);

it("downloads a shared tool only once across independent environment processes", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { createRequire } = await import("node:module");
  const resolve = createRequire(import.meta.url).resolve;
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "pathway-device-download-"));
  try {
    const script = path.join(base, "install.mjs");
    await fs.writeFile(
      script,
      `
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Effect from ${JSON.stringify(resolve("effect/Effect"))};
import * as NodeServices from ${JSON.stringify(resolve("@effect/platform-node/NodeServices"))};
import * as Runner from ${JSON.stringify(new URL("../processRunner.ts", import.meta.url).href)};
import { ensureDeviceHub } from ${JSON.stringify(new URL("./DeviceToolchain.ts", import.meta.url).href)};
const base = ${JSON.stringify(base)};
const runner = { run: input => Effect.promise(async () => {
  if (!input.args.includes('--prefix')) return { code: 0, stdout: '', stderr: '' };
  await fs.appendFile(path.join(base, 'downloads'), 'download\\n');
  const stage = input.args[input.args.indexOf('--prefix') + 1];
  const entry = path.join(stage, 'node_modules/expo-device-hub/dist/server/cli.mjs');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, 'export {};');
  return { code: 0, stdout: '', stderr: '', timedOut: false, stdoutTruncated: false, stderrTruncated: false, stdoutInvalidUtf8: false, stderrInvalidUtf8: false };
}) };
const tool = await Effect.runPromise(ensureDeviceHub(base).pipe(Effect.provideService(Runner.ProcessRunner, runner), Effect.provide(NodeServices.layer)));
console.log(tool.entryPath);
`,
    );
    const results = await Promise.all(
      Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, [script])),
    );
    expect(new Set(results.map((result) => result.stdout.trim())).size).toBe(1);
    expect(await fs.readFile(path.join(base, "downloads"), "utf8")).toBe("download\n");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

it.effect(
  "uses a resolved Node runtime for hub installation and tool updates in standalone distributions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const mode of ["setup", "update"]) {
        const base = yield* fs.makeTempDirectoryScoped({ prefix: `device-${mode}-` });
        const commands: string[] = [];
        yield* ensureDeviceHub(base).pipe(
          Effect.provideService(HostProcessEnvironment, { PATH: path.dirname(process.execPath) }),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.gen(function* () {
                commands.push(input.command);
                if (input.command === "npm") {
                  const args = input.args!;
                  const entry = path.join(
                    args[args.indexOf("--prefix") + 1]!,
                    "node_modules/expo-device-hub/dist/server/cli.mjs",
                  );
                  yield* fs
                    .makeDirectory(path.dirname(entry), { recursive: true })
                    .pipe(Effect.orDie);
                  yield* fs.writeFileString(entry, "").pipe(Effect.orDie);
                }
                return {
                  code: ChildProcessSpawner.ExitCode(0),
                  stdout: "",
                  stderr: "",
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
          }),
        );
        expect(commands).toEqual(["npm", process.execPath]);
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provideService(HostProcessExecutablePath, "/packaged/pathway"),
      Effect.provide(NodeServices.layer),
    ),
);

it.effect("reports native TV build state separately and detects a missing executable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    const binary = path.join(
      base,
      "tools/expo-device-hub",
      DEVICE_HUB_VERSION,
      "node_modules/expo-device-hub/vendor/serve-sim/dist/native/pathway-tv-input",
    );
    yield* fs.makeDirectory(path.dirname(binary), { recursive: true });
    yield* fs.writeFileString(binary + ".json", '{"status":"notBuilt"}');
    expect((yield* deviceToolVersions(base))?.tvInputBuild?.status).toBe("notBuilt");
    yield* fs.writeFileString(binary + ".json", '{"status":"ready"}');
    expect((yield* deviceToolVersions(base))?.tvInputBuild?.status).toBe("unavailable");
    yield* fs.writeFileString(binary, "");
    expect((yield* deviceToolVersions(base))?.tvInputBuild?.status).toBe("ready");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
