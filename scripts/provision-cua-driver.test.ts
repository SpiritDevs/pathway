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

// Answers each command with canned stdout keyed by executable name; `failing`
// names `executable firstArg` pairs that exit non-zero.
const spawnerLayer = (
  commands: Array<RecordedCommand>,
  stdout: Record<string, string>,
  failing: ReadonlyArray<string> = [],
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const child = command as unknown as RecordedCommand;
      commands.push({ command: child.command, args: child.args });
      const exitCode = failing.includes(`${child.command} ${child.args[0]}`) ? 1 : 0;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
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

  const macArtifact = (driver: Uint8Array, overrides: Record<string, unknown> = {}) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifact = yield* fs.makeTempDirectoryScoped();
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
          signingIdentifier: CUA_DRIVER_SIGN_IDENTIFIER,
          ...overrides,
        }),
      );
      return artifact;
    });

  it.effect("re-stages a verified Mac artifact and checks its embedded signing identifier", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const destination = path.join(yield* fs.makeTempDirectoryScoped(), "cua-driver");
      const driver = encoder.encode("signed driver bytes");
      const artifact = yield* macArtifact(driver);
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

      const staged = path.join(destination, "cua-driver");
      assert.deepStrictEqual(commands, [
        { command: "lipo", args: ["-archs", path.join(artifact, "cua-driver")] },
        {
          command: "codesign",
          args: ["--force", "--sign", "Developer ID Application: Pathway", staged],
        },
        {
          command: "codesign",
          args: ["--verify", `-R=identifier "${CUA_DRIVER_SIGN_IDENTIFIER}"`, staged],
        },
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

  it.effect("rejects a cached Mac artifact built before the embedded signing identifier", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifact = yield* macArtifact(encoder.encode("driver"), {
        signingIdentifier: undefined,
      });
      const commands: Array<RecordedCommand> = [];
      const error = yield* Effect.flip(
        provisionCuaDriver({
          destination: path.join(artifact, "out"),
          platform: "darwin",
          arch: "arm64",
          artifactDir: artifact,
        }).pipe(Effect.provide(Layer.mergeAll(hostLayer("darwin"), spawnerLayer(commands, {})))),
      );
      assert.include(error.message, "signing identifier");
      assert.lengthOf(commands, 0);
      assert.isFalse(yield* fs.exists(path.join(artifact, "out")));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to stage a Mac driver whose signature lacks the stable identifier", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifact = yield* macArtifact(encoder.encode("driver without plist"));
      const destination = path.join(yield* fs.makeTempDirectoryScoped(), "cua-driver");
      const error = yield* Effect.flip(
        provisionCuaDriver({
          destination,
          platform: "darwin",
          arch: "arm64",
          artifactDir: artifact,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              hostLayer("darwin"),
              spawnerLayer([], { lipo: "arm64" }, ["codesign --verify"]),
            ),
          ),
        ),
      );
      assert.include(error.message, CUA_DRIVER_SIGN_IDENTIFIER);
      assert.isFalse(yield* fs.exists(path.join(destination, "provenance.json")));
    }).pipe(Effect.scoped),
  );

  // An upstream Windows bundle: the driver plus executable and data sidecars.
  const windowsArtifact = (overrides: Record<string, unknown> = {}) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifact = yield* fs.makeTempDirectoryScoped();
      const driver = encoder.encode("windows driver");
      const sidecars = { "cua-cursor-theme.exe": "theme tool", "uia/helper.dll": "uia helper" };
      yield* fs.writeFile(path.join(artifact, "cua-driver.exe"), driver);
      yield* fs.makeDirectory(path.join(artifact, "uia"));
      for (const [file, contents] of Object.entries(sidecars)) {
        yield* fs.writeFileString(path.join(artifact, file), contents);
      }
      yield* fs.writeFileString(path.join(artifact, "build-key.txt"), "cua-v1-key\n");
      yield* fs.writeFileString(
        path.join(artifact, "provenance.json"),
        yield* encodeJson({
          version: release.version,
          source: release.source,
          nativeRevision: release.nativeRevision,
          platform: "win32",
          patched: false,
          patchSha256: null,
          rustVersion: release.rustVersion,
          architectures: ["x64"],
          binarySha256: sha256Hex(driver),
          sidecarSha256: Object.fromEntries(
            Object.entries(sidecars).map(([file, contents]) => [file, sha256Hex(contents)]),
          ),
          upstreamArchiveSha256: "upstream",
          ...overrides,
        }),
      );
      return artifact;
    });

  const provisionWindows = (artifact: string, destination: string) =>
    provisionCuaDriver({
      destination,
      platform: "win32",
      arch: "x64",
      artifactDir: artifact,
    }).pipe(Effect.provide(Layer.mergeAll(hostLayer("darwin"), spawnerLayer([], {}))));

  it.effect("stages only the checksummed files of a reused upstream bundle", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifact = yield* windowsArtifact();
      const destination = path.join(yield* fs.makeTempDirectoryScoped(), "cua-driver");
      yield* provisionWindows(artifact, destination);
      assert.deepStrictEqual(
        (yield* fs.readDirectory(destination, { recursive: true })).toSorted(),
        [
          "LICENSE.txt",
          "cua-cursor-theme.exe",
          "cua-driver.exe",
          "provenance.json",
          "uia",
          path.join("uia", "helper.dll"),
        ],
      );
      assert.equal(
        yield* fs.readFileString(path.join(destination, "uia", "helper.dll")),
        "uia helper",
      );
    }).pipe(Effect.scoped),
  );

  for (const [name, tamper] of [
    ["a swapped sidecar", "cua-cursor-theme.exe"],
    ["an unrecorded sidecar", "injected.dll"],
  ] as const) {
    it.effect(`rejects a reused upstream bundle with ${name}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const artifact = yield* windowsArtifact();
        yield* fs.writeFileString(path.join(artifact, tamper), "attacker");
        const destination = path.join(yield* fs.makeTempDirectoryScoped(), "cua-driver");
        const error = yield* Effect.flip(provisionWindows(artifact, destination));
        assert.include(error.message, "sidecar");
        assert.isFalse(yield* fs.exists(destination));
      }).pipe(Effect.scoped),
    );
  }

  it.effect("rejects legacy upstream bundles that recorded no sidecar checksums", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifact = yield* windowsArtifact({ sidecarSha256: undefined });
      const error = yield* Effect.flip(
        provisionWindows(artifact, path.join(yield* fs.makeTempDirectoryScoped(), "cua-driver")),
      );
      assert.include(error.message, "sidecar");
    }).pipe(Effect.scoped),
  );
});
