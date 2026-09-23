import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildPathwayHelper, swiftTargetsForArch } from "./build-pathway-helper.ts";

interface RecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

// Records each command and writes a stub binary wherever it names an output.
const spawnerLayer = (fs: FileSystem.FileSystem, commands: Array<RecordedCommand>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const child = command as unknown as RecordedCommand;
      commands.push({ command: child.command, args: child.args });
      const outputFlag = child.args.findIndex((arg) => arg === "-o" || arg === "-output");
      const output = outputFlag === -1 ? undefined : child.args[outputFlag + 1];
      return Effect.orDie(output ? fs.writeFileString(output, "binary") : Effect.void).pipe(
        Effect.as(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    }),
  );

const hostLayer = (platform: NodeJS.Platform) =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessEnvironment, {}),
  );

it.layer(NodeServices.layer)("build-pathway-helper", (it) => {
  it("targets macOS 12.3 for each requested architecture", () => {
    assert.deepStrictEqual(
      swiftTargetsForArch("universal").map((target) => target.target),
      ["arm64-apple-macos12.3", "x86_64-apple-macos12.3"],
    );
    assert.deepStrictEqual(
      swiftTargetsForArch("x64").map((target) => target.arch),
      ["x64"],
    );
  });

  it.effect("refuses to build off macOS", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const commands: Array<RecordedCommand> = [];
      const error = yield* Effect.flip(
        buildPathwayHelper({ repoRoot: ".", arch: "arm64", outputPath: "/unused" }).pipe(
          Effect.provide(Layer.mergeAll(hostLayer("linux"), spawnerLayer(fs, commands))),
        ),
      );
      assert.include(error.message, "only be built on macOS");
      assert.lengthOf(commands, 0);
    }),
  );

  it.effect("builds a universal helper with a pinned identity, then reuses it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const outputPath = path.join(yield* fs.makeTempDirectoryScoped(), "out", "pathway-helper");
      const commands: Array<RecordedCommand> = [];
      const build = buildPathwayHelper({ repoRoot, arch: "universal", outputPath, release: true });
      const layer = Layer.mergeAll(hostLayer("darwin"), spawnerLayer(fs, commands));

      assert.equal(yield* build.pipe(Effect.provide(layer)), outputPath);
      const swiftc = commands.filter((command) => command.args[0] === "swiftc");
      assert.lengthOf(swiftc, 2);
      for (const compile of swiftc) {
        assert.includeMembers(
          [...compile.args],
          ["-O", "-whole-module-optimization", "__info_plist"],
        );
        assert.include(compile.args.join(" "), "native/pathway-helper/Info.plist");
      }
      assert.deepStrictEqual(
        commands.slice(2).map((command) => [command.command, command.args[0]]),
        [
          ["xcrun", "lipo"],
          ["codesign", "--force"],
        ],
      );
      assert.equal(yield* fs.readFileString(outputPath), "binary");
      assert.isTrue(yield* fs.exists(`${outputPath}.build.json`));

      commands.length = 0;
      yield* build.pipe(Effect.provide(layer));
      assert.deepStrictEqual(
        commands.map((command) => [command.command, ...command.args]),
        [["codesign", "--verify", "--strict", outputPath]],
      );
    }).pipe(Effect.scoped),
  );
});
