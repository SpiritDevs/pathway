#!/usr/bin/env node

// The Actions cache is only a transport. The key binds the build environment;
// provisioning still checks every executable and Linux sidecar on import.

import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@spiritdevs/shared/hostProcess";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { commandOutput, sha256Hex } from "./lib/native-command.ts";

export class CuaCacheToolchainOverrideError extends Schema.TaggedErrorClass<CuaCacheToolchainOverrideError>()(
  "CuaCacheToolchainOverrideError",
  { key: Schema.String },
) {
  override get message(): string {
    return `Release Cua cache does not support toolchain override ${this.key}.`;
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

export const cuaCacheKey = (inputs: unknown) => `cua-v1-${sha256Hex(JSON.stringify(inputs))}`;

const BUILD_FLAG_PATTERN =
  /^(CARGO_|RUST|CC($|_)|CXX($|_)|CFLAGS($|_)|CXXFLAGS($|_)|CPPFLAGS($|_)|LDFLAGS($|_)|AR($|_)|PKG_CONFIG|MACOSX_DEPLOYMENT_TARGET$|SDKROOT$)/;

// Compiler paths/wrappers may change bytes at an unchanged path. The release
// cache supports the selected runner toolchain, not arbitrary wrappers.
const TOOLCHAIN_OVERRIDE_PATTERN =
  /^(RUSTC($|_)|RUSTDOC$|CC($|_)|CXX($|_)|AR($|_)|CARGO_BUILD_(RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER)$|CARGO_TARGET_.*_LINKER$)/;

export const cuaBuildFlags = (env: Environment) =>
  Object.fromEntries(
    Object.entries(env)
      .filter(
        ([key]) =>
          BUILD_FLAG_PATTERN.test(key) && !["CARGO_HOME", "CARGO_TARGET_DIR"].includes(key),
      )
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );

const PATCH_ROOT = "native/cua-driver/patches";
const CACHE_INPUT_FILES = [
  "packages/shared/src/cuaDriverRelease.json",
  "scripts/provision-cua-driver.ts",
  "scripts/lib/cua-artifact-provenance.ts",
  "scripts/lib/native-command.ts",
  "scripts/cua-cache-key.ts",
  ".github/actions/provision-cua/action.yml",
];

const LINUX_BUILD_PACKAGES = [
  "libc6-dev",
  "libssl-dev",
  "libx11-dev",
  "libxtst-dev",
  "libxrandr-dev",
  "libxfixes-dev",
  "libxrender-dev",
  "libxcb-shape0-dev",
  "libxcb-xfixes0-dev",
  "libxkbcommon-dev",
  "libwayland-dev",
  "pkg-config",
];

export const collectCuaCacheInputs = Effect.fn("collectCuaCacheInputs")(function* (
  root: string,
  env: Environment,
) {
  const override = Object.keys(env).find((key) => TOOLCHAIN_OVERRIDE_PATTERN.test(key) && env[key]);
  if (override) return yield* new CuaCacheToolchainOverrideError({ key: override });

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const patches = (yield* fs.readDirectory(path.join(root, PATCH_ROOT)))
    .toSorted()
    .map((name) => `${PATCH_ROOT}/${name}`);
  const files: Record<string, string> = {};
  for (const file of [...CACHE_INPUT_FILES, ...patches]) {
    files[file] = sha256Hex(yield* fs.readFile(path.join(root, file)));
  }
  const darwin = platform === "darwin";
  return {
    platform,
    arch,
    os: darwin
      ? yield* commandOutput("sw_vers", ["-productVersion"])
      : yield* fs.readFileString("/etc/os-release"),
    rust: yield* commandOutput("rustc", ["-vV"]),
    cargo: yield* commandOutput("cargo", ["--version"]),
    compiler: yield* commandOutput("cc", ["--version"]),
    sdk: darwin
      ? [
          yield* commandOutput("xcodebuild", ["-version"]),
          yield* commandOutput("xcrun", ["--show-sdk-version"]),
          yield* commandOutput("xcrun", ["--show-sdk-build-version"]),
        ]
      : yield* commandOutput("dpkg-query", [
          "-W",
          "-f=${Package}=${Version}\n",
          ...LINUX_BUILD_PACKAGES,
        ]),
    flags: cuaBuildFlags(env),
    files,
  };
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* HostProcessEnvironment;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const key = cuaCacheKey(yield* collectCuaCacheInputs(root, env));
  yield* Effect.log(key);
  if (env.GITHUB_OUTPUT) {
    yield* fs.writeFileString(env.GITHUB_OUTPUT, `key=${key}\n`, { flag: "a" });
  }
});

if (import.meta.main) {
  main.pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
