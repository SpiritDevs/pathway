import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import release from "../packages/shared/src/cuaDriverRelease.json" with { type: "json" };
import { sha256Hex } from "./lib/native-command.ts";
import { CUA_DRIVER_SIGN_IDENTIFIER, provisionCuaDriver } from "./provision-cua-driver.ts";

interface RecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const encoder = new TextEncoder();
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ platform: Schema.String, binarySha256: Schema.String })),
);

// Answers each command with canned stdout keyed by executable name.
const spawnerLayer = (commands: Array<RecordedCommand>, stdout: Record<string, string>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const child = command as unknown as RecordedCommand;
      commands.push({ command: child.command, args: child.args });
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(stdout[child.command] ?? "")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

const hostLayer = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessEnvironment, env),
  );

it.layer(NodeServices.layer)("provision-cua-driver", (it) => {
  it.effect("refuses a mismatched Rust toolchain before fetching upstream source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const commands: Array<RecordedCommand> = [];
      const destination = yield* fs.makeTempDirectoryScoped();
      const error = yield* Effect.flip(
        provisionCuaDriver({ destination, platform: "darwin", arch: "arm64" }).pipe(
          Effect.provide(
            Layer.mergeAll(
              hostLayer("darwin"),
              spawnerLayer(commands, { rustc: "rustc 1.80.0 (old 2024-07-21)" }),
            ),
          ),
        ),
      );
      assert.include(error.message, `pinned Rust ${release.rustVersion}`);
      assert.deepStrictEqual(
        commands.map((command) => command.command),
        ["rustc"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects macOS builds on other hosts and universal builds elsewhere", () =>
    Effect.gen(function* () {
      const commands: Array<RecordedCommand> = [];
      const layer = spawnerLayer(commands, {});
      const mac = yield* Effect.flip(
        provisionCuaDriver({ destination: "/unused", platform: "darwin", arch: "arm64" }).pipe(
          Effect.provide(Layer.mergeAll(hostLayer("linux"), layer)),
        ),
      );
      assert.include(mac.message, "requires macOS");
      const linux = yield* Effect.flip(
        provisionCuaDriver({ destination: "/unused", platform: "linux", arch: "universal" }).pipe(
          Effect.provide(Layer.mergeAll(hostLayer("linux"), layer)),
        ),
      );
      assert.include(linux.message, "--arch arm64 or x64");
      assert.lengthOf(commands, 0);
    }),
  );

  it.effect("re-stages a verified Mac artifact with a stable signing identifier", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifact = yield* fs.makeTempDirectoryScoped();
      const destination = path.join(yield* fs.makeTempDirectoryScoped(), "cua-driver");
      const driver = encoder.encode("signed driver bytes");
      yield* fs.writeFile(path.join(artifact, "cua-driver"), driver);
      yield* fs.writeFileString(
        path.join(artifact, "provenance.json"),
        yield* encodeJson({
          version: release.version,
          source: release.source,
          nativeRevision: release.nativeRevision,
          platform: "darwin",
          patched: true,
          patchSha256: release.patchSha256,
          rustVersion: release.rustVersion,
          rustcVersion: `rustc ${release.rustVersion} (pinned)`,
          architectures: ["arm64"],
          binarySha256: sha256Hex(driver),
        }),
      );
      const commands: Array<RecordedCommand> = [];
      const provenance = yield* provisionCuaDriver({
        destination,
        platform: "darwin",
        arch: "arm64",
        artifactDir: artifact,
        signIdentity: "Developer ID Application: Pathway",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(hostLayer("darwin"), spawnerLayer(commands, { lipo: "arm64" })),
        ),
      );

      assert.deepStrictEqual(
        commands.map((command) => command.command),
        ["lipo", "codesign"],
      );
      assert.deepStrictEqual(commands[1]!.args.slice(0, 5), [
        "--force",
        "--identifier",
        CUA_DRIVER_SIGN_IDENTIFIER,
        "--sign",
        "Developer ID Application: Pathway",
      ]);
      assert.equal(provenance.signedIdentity, "Developer ID Application: Pathway");
      assert.deepStrictEqual(yield* fs.readFile(path.join(destination, "cua-driver")), driver);
      const written = yield* decodeJson(
        yield* fs.readFileString(path.join(destination, "provenance.json")),
      );
      assert.equal(written.platform, "darwin");
      assert.equal(written.binarySha256, sha256Hex(driver));
      assert.include(
        yield* fs.readFileString(path.join(destination, "LICENSE.txt")),
        "Cua AI, Inc.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a reused artifact whose bytes no longer match its provenance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifact = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(artifact, "cua-driver"), "tampered");
      yield* fs.writeFileString(
        path.join(artifact, "provenance.json"),
        yield* encodeJson({
          version: release.version,
          source: release.source,
          nativeRevision: release.nativeRevision,
          platform: "darwin",
          patchSha256: release.patchSha256,
          rustVersion: release.rustVersion,
          architectures: ["arm64"],
          binarySha256: sha256Hex("original"),
        }),
      );
      const commands: Array<RecordedCommand> = [];
      const error = yield* Effect.flip(
        provisionCuaDriver({
          destination: path.join(artifact, "out"),
          platform: "darwin",
          arch: "arm64",
          artifactDir: artifact,
        }).pipe(Effect.provide(Layer.mergeAll(hostLayer("darwin"), spawnerLayer(commands, {})))),
      );
      assert.include(error.message, "binary checksum mismatch");
      assert.lengthOf(commands, 0);
      assert.isFalse(yield* fs.exists(path.join(artifact, "out")));
    }).pipe(Effect.scoped),
  );
});
