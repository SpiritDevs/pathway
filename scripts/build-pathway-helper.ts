#!/usr/bin/env node

// Builds native/pathway-helper into one ad-hoc signed Mach-O. Release packaging
// re-signs it with the app's identity because the bundle path is in mac.binaries.

import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@spiritdevs/shared/hostProcess";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { commandOutput, runInherited, sha256Hex } from "./lib/native-command.ts";

export class PathwayHelperBuildError extends Schema.TaggedErrorClass<PathwayHelperBuildError>()(
  "PathwayHelperBuildError",
  { message: Schema.String },
) {}

export type PathwayHelperArch = "arm64" | "x64" | "universal";

const SOURCE_DIR = "native/pathway-helper";
export const DEFAULT_PATHWAY_HELPER_OUTPUT =
  "apps/desktop/.electron-runtime/pathway-helper/pathway-helper";

const FRAMEWORK_ARGS = [
  "AppKit",
  "CoreServices",
  "CoreGraphics",
  "CoreImage",
  "CoreMedia",
  "CoreVideo",
  "ScreenCaptureKit",
].flatMap((framework) => ["-framework", framework]);

// codesign names a bare Mach-O after its LC_UUID, which changes every build, and
// electron-builder's Developer ID re-sign passes no --identifier. An embedded
// Info.plist pins the identifier (com.spiritdevs.pathway.helper) through any re-sign.
const infoPlistArgs = (infoPlist: string) =>
  ["-sectcreate", "__TEXT", "__info_plist", infoPlist].flatMap((arg) => ["-Xlinker", arg]);

// Standalone checks for the pure pieces of the helper; see each main.swift.
const NATIVE_TESTS = [
  {
    name: "escape-classifier",
    sources: ["EscapePhysicalClassifier.swift"],
    frameworks: ["CoreGraphics", "Foundation"],
  },
  {
    name: "permission-registration",
    sources: ["PermissionSetupRegistration.swift"],
    frameworks: ["AppKit", "CoreServices"],
  },
] as const;

export function swiftTargetsForArch(arch: PathwayHelperArch) {
  const arm64 = { arch: "arm64", target: "arm64-apple-macos12.3" } as const;
  const x64 = { arch: "x64", target: "x86_64-apple-macos12.3" } as const;
  return arch === "universal" ? [arm64, x64] : arch === "arm64" ? [arm64] : [x64];
}

const BuildMetadata = Schema.fromJsonString(Schema.Struct({ fingerprint: Schema.String }));
const decodeBuildMetadata = Schema.decodeEffect(BuildMetadata);
const encodeBuildMetadata = Schema.encodeEffect(BuildMetadata);

const requireMac = Effect.gen(function* () {
  if ((yield* HostProcessPlatform) !== "darwin") {
    return yield* new PathwayHelperBuildError({
      message: "The Pathway helper can only be built on macOS.",
    });
  }
});

const moduleCacheEnv = (directory: string) => ({
  CLANG_MODULE_CACHE_PATH: directory,
  SWIFT_MODULECACHE_PATH: directory,
});

export interface BuildPathwayHelperOptions {
  readonly repoRoot: string;
  readonly arch: PathwayHelperArch;
  readonly outputPath: string;
  readonly release?: boolean | undefined;
}

/** Compiles the helper unless a signed build with the same inputs is already at `outputPath`. */
export const buildPathwayHelper = Effect.fn("buildPathwayHelper")(function* (
  options: BuildPathwayHelperOptions,
) {
  yield* requireMac;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const release = options.release === true;
  const targets = swiftTargetsForArch(options.arch);
  const sourceDir = path.join(options.repoRoot, SOURCE_DIR);
  const sources = (yield* fs.readDirectory(sourceDir))
    .filter((name) => name.endsWith(".swift"))
    .toSorted()
    .map((name) => path.join(sourceDir, name));
  if (sources.length === 0) {
    return yield* new PathwayHelperBuildError({
      message: `No Swift sources found in ${sourceDir}.`,
    });
  }

  const infoPlist = path.join(sourceDir, "Info.plist");
  const outputPath = path.resolve(options.outputPath);
  const metadataPath = `${outputPath}.build.json`;
  const fingerprintParts = [
    "pathway-helper-build-v1",
    options.arch,
    release ? "release" : "debug",
    targets.map((target) => target.target).join(","),
    FRAMEWORK_ARGS.join(" "),
    sha256Hex(yield* fs.readFile(path.join(options.repoRoot, "scripts/build-pathway-helper.ts"))),
  ];
  for (const source of [...sources, infoPlist]) {
    fingerprintParts.push(path.basename(source), sha256Hex(yield* fs.readFile(source)));
  }
  const fingerprint = sha256Hex(fingerprintParts.join("\0"));

  const cached = yield* Effect.gen(function* () {
    const metadata = yield* decodeBuildMetadata(yield* fs.readFileString(metadataPath));
    if (metadata.fingerprint !== fingerprint) return false;
    yield* commandOutput("codesign", ["--verify", "--strict", outputPath]);
    return true;
  }).pipe(Effect.orElseSucceed(() => false));
  if (cached) {
    yield* Effect.logInfo(`[pathway-helper] Reusing ${options.arch} build at ${outputPath}`);
    return outputPath;
  }

  const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-helper-" });
  const env = {
    ...(yield* HostProcessEnvironment),
    ...moduleCacheEnv(path.join(temporaryDirectory, "module-cache")),
  };
  const thinBinaries: Array<string> = [];
  for (const target of targets) {
    const thinBinary = path.join(temporaryDirectory, `pathway-helper-${target.arch}`);
    yield* runInherited(
      "xcrun",
      [
        "swiftc",
        ...(release ? ["-O", "-whole-module-optimization"] : ["-Onone", "-g"]),
        "-module-name",
        "PathwayHelper",
        "-target",
        target.target,
        ...FRAMEWORK_ARGS,
        ...sources,
        ...infoPlistArgs(infoPlist),
        "-o",
        thinBinary,
      ],
      { env },
    );
    thinBinaries.push(thinBinary);
  }

  const unsignedBinary = path.join(temporaryDirectory, "pathway-helper");
  if (thinBinaries.length === 1) {
    yield* fs.copyFile(thinBinaries[0]!, unsignedBinary);
  } else {
    yield* runInherited("xcrun", ["lipo", "-create", ...thinBinaries, "-output", unsignedBinary]);
  }
  yield* runInherited("codesign", ["--force", "--sign", "-", "--timestamp=none", unsignedBinary]);

  // Rename into place so a concurrent launcher never sees a half-written binary.
  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  const pendingOutput = path.join(path.dirname(outputPath), `.pathway-helper-${fingerprint}`);
  yield* fs.copyFile(unsignedBinary, pendingOutput);
  yield* fs.chmod(pendingOutput, 0o755);
  yield* fs.rename(pendingOutput, outputPath);
  const pendingMetadata = `${pendingOutput}.build.json`;
  yield* fs.writeFileString(pendingMetadata, `${yield* encodeBuildMetadata({ fingerprint })}\n`, {
    mode: 0o600,
  });
  yield* fs.rename(pendingMetadata, metadataPath);

  yield* Effect.logInfo(
    `[pathway-helper] Built ${options.arch} helper for macOS 12.3+ at ${outputPath}`,
  );
  return outputPath;
}, Effect.scoped);

/** Compiles and runs the helper's standalone native tests. */
export const runPathwayHelperNativeTests = Effect.fn("runPathwayHelperNativeTests")(function* (
  repoRoot: string,
) {
  yield* requireMac;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceDir = path.join(repoRoot, SOURCE_DIR);
  const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-helper-tests-" });
  const env = {
    ...(yield* HostProcessEnvironment),
    ...moduleCacheEnv(path.join(temporaryDirectory, "mc")),
  };
  for (const test of NATIVE_TESTS) {
    const binary = path.join(temporaryDirectory, test.name);
    yield* runInherited(
      "xcrun",
      [
        "swiftc",
        "-O",
        ...test.sources.map((source) => path.join(sourceDir, source)),
        path.join(sourceDir, "tests", test.name, "main.swift"),
        ...test.frameworks.flatMap((framework) => ["-framework", framework]),
        "-o",
        binary,
      ],
      { env },
    );
    yield* runInherited(binary, []);
  }
}, Effect.scoped);

const buildPathwayHelperCli = Command.make("build-pathway-helper", {
  arch: Flag.choice("arch", ["arm64", "x64", "universal"]).pipe(Flag.optional),
  output: Flag.string("output").pipe(
    Flag.withDescription(`Output path (default: ${DEFAULT_PATHWAY_HELPER_OUTPUT}).`),
    Flag.optional,
  ),
  release: Flag.boolean("release").pipe(Flag.withDefault(false)),
  nativeTests: Flag.boolean("native-tests").pipe(
    Flag.withDescription("Compile and run the helper's native tests instead of building."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Build the macOS pathway-helper binary."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      if (input.nativeTests) return yield* runPathwayHelperNativeTests(repoRoot);
      const hostArch = yield* HostProcessArchitecture;
      const arch = Option.getOrElse(input.arch, () => (hostArch === "x64" ? "x64" : "arm64"));
      yield* buildPathwayHelper({
        repoRoot,
        arch,
        outputPath: Option.getOrElse(input.output, () =>
          path.join(repoRoot, DEFAULT_PATHWAY_HELPER_OUTPUT),
        ),
        release: input.release,
      });
    }),
  ),
);

if (import.meta.main) {
  Command.run(buildPathwayHelperCli, { version: "1" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
