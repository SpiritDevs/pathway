#!/usr/bin/env node

// Build the exact upstream commit plus the native patch required by the host.
// The upstream binary archive is baseline provenance, never a patched artifact.

import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@spiritdevs/shared/hostProcess";
import release from "../packages/shared/src/cuaDriverRelease.json" with { type: "json" };
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  assertCuaArtifactProvenance,
  assertLinuxCuaBinaryIdentity,
  assertLinuxCuaBuildHost,
  assertLinuxCuaSidecarChecksums,
  type CuaArch,
  CuaArtifactProvenance,
  type CuaPlatform,
  LINUX_CUA_INPUT_SCOPE,
  LINUX_CUA_SIDECAR_PATHS,
} from "./lib/cua-artifact-provenance.ts";
import { commandOutput, runInherited, sha256Hex } from "./lib/native-command.ts";

export class CuaProvisionError extends Schema.TaggedErrorClass<CuaProvisionError>()(
  "CuaProvisionError",
  { message: Schema.String },
) {}

/** Stable signing identifier so macOS TCC remembers the driver across rebuilds. */
export const CUA_DRIVER_SIGN_IDENTIFIER = "com.spiritdevs.pathway.cua.driver";

const PATCH_DIR = "native/cua-driver/patches";
const NATIVE_PATCH = "0001-pathway-native.patch";
const LINUX_BROWSER_PATCH = "0002-pathway-linux-browser.patch";

const TARGETS = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  win32: { arm64: "windows-arm64", x64: "windows-x86_64" },
  linux: { arm64: "linux-arm64", x64: "linux-x86_64" },
} as const;
const SOURCE_TARGETS = {
  darwin: TARGETS.darwin,
  linux: { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" },
} as const;
// Windows keeps the pinned upstream artifact. Linux builds the browser-only
// cancellation delta after the base patch; this does not enable native input.
const UPSTREAM_ASSET = {
  win32: { binary: "cua-driver.exe", suffix: "zip" },
  linux: { binary: "cua-driver", suffix: "tar.gz" },
} as const;

export interface ProvisionCuaDriverOptions {
  readonly destination: string;
  readonly platform: CuaPlatform;
  readonly arch: CuaArch | "universal";
  /** Reuse a verified artifact. Falls back to `PATHWAY_CUA_ARTIFACT_DIR`. */
  readonly artifactDir?: string | undefined;
  /** Developer ID to sign with. Falls back to `PATHWAY_CUA_SIGN_IDENTITY`; ad-hoc otherwise. */
  readonly signIdentity?: string | undefined;
  readonly sourceCheckout?: string | undefined;
  readonly offline?: boolean | undefined;
}

const fail = (message: string) => Effect.fail(new CuaProvisionError({ message }));

const fetchBytes = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(
      (cause) => new CuaProvisionError({ message: `Failed to download ${url}: ${cause.message}` }),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

const ProvenanceJson = Schema.fromJsonString(CuaArtifactProvenance);
const decodeProvenance = Schema.decodeUnknownEffect(ProvenanceJson);
const encodeProvenance = Schema.encodeEffect(ProvenanceJson);

type MutableProvenance = { -readonly [K in keyof CuaArtifactProvenance]: CuaArtifactProvenance[K] };

export const provisionCuaDriver = Effect.fn("provisionCuaDriver")(function* (
  options: ProvisionCuaDriverOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArch = yield* HostProcessArchitecture;
  const hostEnv = yield* HostProcessEnvironment;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

  const { platform, arch } = options;
  const destination = path.resolve(options.destination);
  const architectures: ReadonlyArray<CuaArch> = arch === "universal" ? ["arm64", "x64"] : [arch];
  const artifact = options.artifactDir ?? hostEnv.PATHWAY_CUA_ARTIFACT_DIR;
  const signIdentity = options.signIdentity ?? hostEnv.PATHWAY_CUA_SIGN_IDENTITY;
  const patchPath = path.join(repoRoot, PATCH_DIR, NATIVE_PATCH);
  const linuxPatchPath = path.join(repoRoot, PATCH_DIR, LINUX_BROWSER_PATCH);

  if (
    (platform === "darwin" && hostPlatform !== "darwin") ||
    (platform !== "darwin" && arch === "universal")
  ) {
    return yield* fail(
      platform === "darwin"
        ? "Native Cua provisioning requires macOS and --arch arm64, x64 or universal."
        : `Cua provisioning for ${platform} requires --platform win32|linux and --arch arm64 or x64.`,
    );
  }
  if (sha256Hex(yield* fs.readFile(patchPath)) !== release.patchSha256) {
    return yield* fail("Cua native patch checksum mismatch.");
  }
  if (platform === "linux") {
    if (sha256Hex(yield* fs.readFile(linuxPatchPath)) !== release.linuxBrowserPatchSha256) {
      return yield* fail("Cua Linux browser patch checksum mismatch.");
    }
    yield* assertLinuxCuaBuildHost({ platform, hostPlatform, arch, hostArch, artifact });
  }

  const environment: Record<string, string | undefined> = {
    ...hostEnv,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
    GIT_TERMINAL_PROMPT: "0",
    // The pinned Rust toolchain's debug stripping can misalign proc-macro
    // dylibs, which macOS 27 refuses to load (rust-lang/rust#157750). Preserve
    // symbols during this build; do not change the pinned compiler or source.
    ...(platform === "darwin"
      ? { CARGO_PROFILE_RELEASE_STRIP: hostEnv.CARGO_PROFILE_RELEASE_STRIP ?? "none" }
      : {}),
  };
  const run = (binary: string, args: ReadonlyArray<string>, cwd?: string) =>
    runInherited(binary, args, { cwd, env: environment });
  const output = (binary: string, args: ReadonlyArray<string>, cwd?: string) =>
    commandOutput(binary, args, { cwd, env: environment });

  // Check the compiler before fetching ~190 MB of upstream source: a missing or
  // mismatched toolchain is the common failure and needs no network to detect.
  if (!artifact && platform !== "win32") {
    const found = yield* output("rustc", ["--version"]).pipe(
      Effect.orElseSucceed(() => "no rustc on PATH"),
    );
    if (!found.startsWith(`rustc ${release.rustVersion} `)) {
      return yield* fail(
        `Cua Driver needs the pinned Rust ${release.rustVersion} toolchain; found ${found}. Install it with: rustup toolchain install ${release.rustVersion}, then build with RUSTUP_TOOLCHAIN=${release.rustVersion} (or rustup default ${release.rustVersion}).`,
      );
    }
  }

  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-cua-package-" });
  const digestFile = (file: string) => Effect.map(fs.readFile(file), sha256Hex);

  let binary: string;
  let provenance: MutableProvenance;
  let linuxSidecars: Record<string, Uint8Array> | undefined;
  let upstreamDirectory: string | undefined;

  if (artifact) {
    const artifactDir = path.resolve(artifact);
    binary = path.join(artifactDir, platform === "win32" ? "cua-driver.exe" : "cua-driver");
    provenance = {
      ...(yield* decodeProvenance(
        yield* fs.readFileString(path.join(artifactDir, "provenance.json")),
      ).pipe(
        Effect.mapError(
          () => new CuaProvisionError({ message: "Cua artifact provenance.json is malformed." }),
        ),
      )),
    };
    yield* assertCuaArtifactProvenance({
      provenance,
      release,
      platform,
      architectures,
      binarySha256: yield* digestFile(binary),
    });
    if (platform === "linux" && provenance.patched === true) {
      const sidecars: Record<string, Uint8Array> = {};
      for (const sidecar of LINUX_CUA_SIDECAR_PATHS) {
        sidecars[sidecar] = yield* fs.readFile(path.join(artifactDir, sidecar));
      }
      linuxSidecars = sidecars;
      yield* assertLinuxCuaSidecarChecksums(
        provenance,
        Object.fromEntries(
          Object.entries(sidecars).map(([file, bytes]) => [file, sha256Hex(bytes)]),
        ),
      );
    }
    upstreamDirectory = artifactDir;
  } else if (platform === "win32") {
    // Windows: stage the upstream release binary for the pinned version. The
    // authoritative checksum comes from the release's own checksums.txt,
    // verified before anything reaches the destination.
    const releaseBase = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}`;
    const checksums = new TextDecoder().decode(yield* fetchBytes(`${releaseBase}/checksums.txt`));
    const expected = new Map(
      [...checksums.matchAll(/^([0-9a-f]{64})\s+(\S+)$/gm)].map((match) => [match[2], match[1]]),
    );
    const staged = path.join(temporary, "upstream");
    yield* fs.makeDirectory(staged);
    const assetName = `cua-driver-rs-${release.version}-${TARGETS.win32[architectures[0]!]}-binary.${UPSTREAM_ASSET.win32.suffix}`;
    const wantSha = expected.get(assetName);
    if (!wantSha) return yield* fail(`Upstream release has no checksum for ${assetName}.`);
    const downloaded = yield* fetchBytes(`${releaseBase}/${assetName}`);
    if (sha256Hex(downloaded) !== wantSha) {
      return yield* fail(`Upstream ${assetName} checksum mismatch.`);
    }
    const archivePath = path.join(temporary, assetName);
    yield* fs.writeFile(archivePath, downloaded);
    // bsdtar (macOS, Windows) reads zip and tar.gz; GNU tar does not read
    // zip, so fall back to unzip for the Windows asset on Linux hosts.
    yield* run("tar", ["-xf", archivePath, "-C", staged]).pipe(
      Effect.catch(() => run("unzip", ["-o", archivePath, "-d", staged])),
    );
    binary = path.join(staged, UPSTREAM_ASSET.win32.binary);
    upstreamDirectory = staged;
    provenance = {
      version: release.version,
      source: release.source,
      nativeRevision: release.nativeRevision,
      patched: false,
      patchSha256: null,
      rustVersion: release.rustVersion,
      platform,
      architectures,
      binarySha256: yield* digestFile(binary),
      upstreamArchiveSha256: wantSha,
    };
  } else {
    let source: string;
    if (options.sourceCheckout) source = path.resolve(options.sourceCheckout);
    else {
      source = path.join(temporary, "upstream");
      yield* run("git", ["init", "--bare", source]);
      yield* run("git", [
        "-C",
        source,
        "fetch",
        "--depth=1",
        "https://github.com/trycua/cua.git",
        release.source,
      ]);
    }
    const commit = yield* output("git", ["-C", source, "rev-parse", `${release.source}^{commit}`]);
    if (commit !== release.source) return yield* fail("Cua source commit mismatch.");
    const archive = path.join(temporary, "source.tar");
    // Ignore local checkout edits; only the pinned commit enters the build.
    yield* run("git", [
      "-C",
      source,
      "archive",
      `--output=${archive}`,
      release.source,
      "libs/cua-driver",
    ]);
    const build = path.join(temporary, "build");
    yield* fs.makeDirectory(build);
    yield* run("tar", ["-xf", archive, "-C", build]);
    yield* run("patch", ["--batch", "--forward", "-p1", "-i", patchPath], build);
    if (platform === "linux") {
      yield* run("patch", ["--batch", "--forward", "-p1", "-i", linuxPatchPath], build);
    }
    const rust = path.join(build, "libs/cua-driver/rust");
    const rustcVersion = yield* output("rustc", ["--version"], rust);
    if (!rustcVersion.startsWith(`rustc ${release.rustVersion} `)) {
      return yield* fail(
        `Use the pinned Rust ${release.rustVersion} toolchain; found ${rustcVersion}.`,
      );
    }
    const workspace = yield* fs.readFileString(path.join(rust, "Cargo.toml"));
    if (!workspace.includes(`version = "${release.version}"`)) {
      return yield* fail("Cua source package version mismatch.");
    }
    const targetDir = path.resolve(hostEnv.CARGO_TARGET_DIR || path.join(temporary, "target"));
    const binaries: Array<string> = [];
    for (const architecture of architectures) {
      const target = SOURCE_TARGETS[platform][architecture];
      yield* run(
        "cargo",
        [
          "build",
          "--release",
          "--locked",
          "--target-dir",
          targetDir,
          "--target",
          target,
          "-p",
          "cua-driver",
          ...(platform === "linux" ? ["-p", "cursor-theme-cli"] : []),
          ...(options.offline ? ["--offline"] : []),
        ],
        rust,
      );
      binaries.push(path.join(targetDir, target, "release/cua-driver"));
    }
    binary = path.join(temporary, "cua-driver");
    if (binaries.length > 1) yield* run("lipo", ["-create", ...binaries, "-output", binary]);
    else yield* fs.copyFile(binaries[0]!, binary);
    if (platform === "linux") {
      const target = SOURCE_TARGETS.linux[architectures[0]!];
      const sidecars: Record<string, Uint8Array> = {};
      for (const sidecar of LINUX_CUA_SIDECAR_PATHS) {
        sidecars[sidecar] = yield* fs.readFile(
          sidecar === "cua-cursor-theme"
            ? path.join(targetDir, target, "release/cua-cursor-theme")
            : path.join(build, "libs/cua-driver", sidecar),
        );
      }
      linuxSidecars = sidecars;
    }
    provenance = {
      version: release.version,
      source: release.source,
      nativeRevision: release.nativeRevision,
      platform,
      patched: true,
      patchSha256: release.patchSha256,
      ...(platform === "linux" && linuxSidecars
        ? {
            linuxBrowserPatchSha256: release.linuxBrowserPatchSha256,
            browserInputControl: release.linuxBrowserInputControl,
            inputScope: LINUX_CUA_INPUT_SCOPE,
            sidecarSha256: Object.fromEntries(
              Object.entries(linuxSidecars).map(([file, bytes]) => [file, sha256Hex(bytes)]),
            ),
          }
        : {}),
      rustVersion: release.rustVersion,
      rustcVersion,
      architectures,
      binarySha256: yield* digestFile(binary),
      ...(platform === "linux"
        ? { sourceArchiveSha256: yield* digestFile(archive) }
        : { upstreamArchiveSha256: release.sha256 }),
    };
  }

  if (platform === "darwin") {
    // Validate a foreign architecture without requiring Rosetta. The GUI also
    // verifies version, native revision, embedded mode and PID before dispatch.
    const present = (yield* output("lipo", ["-archs", binary])).split(/\s+/);
    if (architectures.some((value) => !present.includes(value === "x64" ? "x86_64" : "arm64"))) {
      return yield* fail("Cua Mach-O is missing a requested architecture.");
    }
  } else if (platform === "linux") {
    yield* assertLinuxCuaBinaryIdentity(yield* fs.readFile(binary), architectures);
    if (linuxSidecars) {
      yield* assertLinuxCuaBinaryIdentity(linuxSidecars["cua-cursor-theme"]!, architectures);
    }
  }

  yield* fs.makeDirectory(destination, { recursive: true });
  if (platform === "win32" || (platform === "linux" && provenance.patched === false)) {
    // The upstream archive is a bundle — driver plus its sidecars (cursor
    // theme, SDK, node runtime, UIA/Wayland helpers). Stage them all — from
    // the verified artifact dir when one was supplied, else the download.
    yield* fs.copy(upstreamDirectory!, destination, { overwrite: true });
    if (platform !== "win32") yield* fs.chmod(path.join(destination, "cua-driver"), 0o755);
  } else if (platform === "linux") {
    // A previous upstream install may have left separately loadable SDK
    // binaries here. They are not used by Pathway's direct daemon transport
    // and must not masquerade as this newly patched runtime.
    for (const obsolete of [
      "libcua_driver_sdk.so",
      "cua_driver_node_runtime.node",
      "cua_driver_abi.h",
    ]) {
      yield* fs.remove(path.join(destination, obsolete), { force: true });
    }
    yield* fs.writeFile(path.join(destination, "cua-driver"), yield* fs.readFile(binary));
    yield* fs.chmod(path.join(destination, "cua-driver"), 0o755);
    for (const [sidecar, bytes] of Object.entries(linuxSidecars ?? {})) {
      const stagedPath = path.join(destination, sidecar);
      yield* fs.makeDirectory(path.dirname(stagedPath), { recursive: true });
      yield* fs.writeFile(stagedPath, bytes);
      if (sidecar === "cua-cursor-theme" || sidecar.endsWith(".sh")) {
        yield* fs.chmod(stagedPath, 0o755);
      }
    }
  } else {
    // Stage via a content write, not copyFile: macOS clonefile carries the
    // protected com.apple.provenance xattr, and Gatekeeper kills the staged
    // binary (SIGKILL at exec) when that marker survives onto a new path.
    const staged = path.join(destination, "cua-driver");
    yield* fs.writeFile(staged, yield* fs.readFile(binary));
    yield* fs.chmod(staged, 0o755);
    // Re-stamp the signature. Default is a plain adhoc signature (the linker's
    // embedded `linker-signed` flag signature is killed at exec on recent
    // macOS). When a signing identity is supplied, use it with a stable
    // identifier so macOS TCC remembers this driver across rebuilds instead of
    // prompting as a brand-new unknown app every time.
    yield* run("codesign", [
      "--force",
      ...(signIdentity
        ? ["--identifier", CUA_DRIVER_SIGN_IDENTIFIER, "--sign", signIdentity]
        : ["--sign", "-"]),
      staged,
    ]);
    // Signing rewrites the executable bytes, so record the digest of the
    // final staged file. The reuse path verifies binarySha256 against exactly
    // these bytes.
    if (signIdentity) provenance.signedIdentity = signIdentity;
    provenance.binarySha256 = yield* digestFile(staged);
  }
  // Legacy Mac artifacts predate the platform field; Mach-O/lipo verification
  // above establishes it without invalidating or recompiling their signed bytes.
  provenance.platform = platform;
  yield* fs.writeFileString(
    path.join(destination, "provenance.json"),
    `${yield* encodeProvenance(provenance)}\n`,
  );
  yield* fs.copyFile(
    path.join(repoRoot, "docs/computer-use-cua/CUA-LICENSE.txt"),
    path.join(destination, "LICENSE.txt"),
  );
  yield* Effect.logInfo(
    `Cua ${release.version} ${
      provenance.patched === false
        ? "upstream (unpatched, no browser input control)"
        : platform === "linux"
          ? `browser input control ${provenance.browserInputControl}, native desktop input unavailable`
          : `native revision ${release.nativeRevision}`
    } (${architectures.join("+")}) staged at ${destination}`,
  );
  return provenance;
}, Effect.scoped);

const toCuaPlatform = (value: string): CuaPlatform | undefined =>
  value === "darwin" || value === "linux" || value === "win32" ? value : undefined;

const provisionCuaDriverCli = Command.make("provision-cua-driver", {
  destination: Flag.string("destination").pipe(
    Flag.withDescription("Staging directory (default: apps/desktop/.electron-runtime/cua-driver)."),
    Flag.optional,
  ),
  platform: Flag.choice("platform", ["darwin", "linux", "win32"]).pipe(Flag.optional),
  arch: Flag.choice("arch", ["arm64", "x64", "universal"]).pipe(Flag.optional),
  artifactDir: Flag.string("artifact-dir").pipe(
    Flag.withDescription("Reuse a verified artifact (env: PATHWAY_CUA_ARTIFACT_DIR)."),
    Flag.optional,
  ),
  signIdentity: Flag.string("sign-identity").pipe(
    Flag.withDescription("Codesign identity (env: PATHWAY_CUA_SIGN_IDENTITY); ad-hoc otherwise."),
    Flag.optional,
  ),
  sourceCheckout: Flag.string("source-checkout").pipe(Flag.optional),
  offline: Flag.boolean("offline").pipe(Flag.withDefault(false)),
  archive: Flag.string("archive").pipe(Flag.withHidden, Flag.optional),
}).pipe(
  Command.withDescription("Build and stage the pinned, patched Cua driver."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      if (Option.isSome(input.archive)) {
        return yield* fail(
          "The upstream binary lacks Pathway's native patch. Use --source-checkout or --artifact-dir instead.",
        );
      }
      const path = yield* Path.Path;
      const hostPlatform = yield* HostProcessPlatform;
      const hostArch = yield* HostProcessArchitecture;
      const platform = Option.getOrUndefined(input.platform) ?? toCuaPlatform(hostPlatform);
      const arch = Option.getOrUndefined(input.arch) ?? hostArch;
      if (!platform || (arch !== "arm64" && arch !== "x64" && arch !== "universal")) {
        return yield* fail(`Cua provisioning does not support ${hostPlatform}/${hostArch}.`);
      }
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      yield* provisionCuaDriver({
        destination: Option.getOrElse(input.destination, () =>
          path.join(repoRoot, "apps/desktop/.electron-runtime/cua-driver"),
        ),
        platform,
        arch,
        artifactDir: Option.getOrUndefined(input.artifactDir),
        signIdentity: Option.getOrUndefined(input.signIdentity),
        sourceCheckout: Option.getOrUndefined(input.sourceCheckout),
        offline: input.offline,
      });
    }),
  ),
);

if (import.meta.main) {
  Command.run(provisionCuaDriverCli, { version: release.version }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
