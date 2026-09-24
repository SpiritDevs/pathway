// @effect-diagnostics nodeBuiltinImport:off - hashes fixture bytes the way the release workflow does.
import { createHash } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ComputerBackendError } from "./computerErrors.ts";
import {
  ENV_SCRIPT_NAME,
  describePrebuiltHost,
  ensureEnvScript,
  envScriptPath,
  allocatePluginId,
  highestInstalledPluginNumber,
  installPluginBytes,
  installStampPath,
  pluginIdCounterPath,
  pluginIdNumber,
  pruneSupersededPlugins,
  provisionKWinPlugin,
  readPrebuiltManifest,
  renderEnvScript,
  resolveInstallTarget,
  selectPrebuilt,
  readVerifiedPrebuilt,
  sessionSeesPluginRoot,
  verifyPrebuiltBytes,
  writeInstallStamp,
  type PrebuiltHost,
  type ProvisionDependencies,
} from "./kwinPluginProvisioning.ts";
import type { HostToolchainReaders } from "./provisioning/hostToolchain.ts";
import { commandOnPath } from "./provisioning/systemPackages.ts";

type TestServices =
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

type TestError = PlatformError.PlatformError | ComputerBackendError;

/** A test over the real filesystem and processes. */
const fsTest = (name: string, body: () => Effect.Effect<void, TestError, TestServices>) =>
  it.live(name, () => body().pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

/**
 * Provisioning runs under the `flock(1)` installer lock, which is util-linux:
 * present wherever the plugin is installed, usually absent elsewhere.
 */
const provisioningTest = (name: string, body: () => Effect.Effect<void, TestError, TestServices>) =>
  it.live.skipIf(!commandOnPath("flock"))(name, () =>
    body().pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

/** The error `effect` fails with; succeeding instead fails the test. */
const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.orDie);

const temp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "pathway-provision-" });
});

const join = (...parts: string[]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(...parts);
  });

const sha256 = (contents: string) => createHash("sha256").update(contents).digest("hex");
const bytes = (contents: string) => new TextEncoder().encode(contents);
const text = (data: Uint8Array | undefined) =>
  data === undefined ? undefined : new TextDecoder().decode(data);

const writeText = (path: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(path, contents);
  });
const readText = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path);
  });
const listSorted = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.readDirectory(path)).toSorted();
  });
const makeDirectory = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path, { recursive: true });
  });

const writeManifest = (path: string, manifest: unknown) =>
  writeText(path, JSON.stringify(manifest));

/** Runs a shell snippet and hands back its stdout. */
const sh = (script: string, env?: Record<string, string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(
      ChildProcess.make("sh", ["-c", script], env ? { env, extendEnv: true } : {}),
    );
  });

/** The candidate list every caller passes: both spellings, in preference order. */
const SYSTEM_QT_ROOTS = ["/usr/lib64/qt6/plugins", "/usr/lib/qt6/plugins"];
const onDisk =
  (...present: readonly string[]) =>
  (path: string) =>
    present.includes(path);
/** No PATHWAY_KWIN_PLUGIN_DIR: the tests below decide from the disk alone. */
const cleanEnv = {};

describe("install target", () => {
  it("follows the system Qt's lib64/lib split rather than guessing it", () => {
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib64/qt6/plugins"), cleanEnv)
        .qtPluginRoot,
    ).toBe("/home/x/.local/lib64/qt6/plugins");
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib/qt6/plugins"), cleanEnv)
        .qtPluginRoot,
    ).toBe("/home/x/.local/lib/qt6/plugins");
  });

  /**
   * The regression that mattered: every caller hands over both spellings, so a
   * decision made by reading the list rather than the disk answered lib64 on
   * Debian and Arch too, and installed the plugin into a directory the env
   * script never put on QT_PLUGIN_PATH.
   */
  it("reads the split off the disk, not off the candidate list", () => {
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib/qt6/plugins"), cleanEnv)
        .qtPluginRoot,
    ).toBe("/home/x/.local/lib/qt6/plugins");
    // Neither present: the script's `else` branch, which is lib.
    expect(resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk(), cleanEnv).qtPluginRoot).toBe(
      "/home/x/.local/lib/qt6/plugins",
    );
  });

  it("puts the plugin where KWin scans, under the root it will be told about", () => {
    const target = resolveInstallTarget(
      SYSTEM_QT_ROOTS,
      "/home/x",
      onDisk("/usr/lib64/qt6/plugins"),
      cleanEnv,
    );
    expect(target.pluginDirectory).toBe(`${target.qtPluginRoot}/kwin/plugins`);
  });

  it("honours PATHWAY_KWIN_PLUGIN_DIR exactly as the installer script does", () => {
    // The script's PLUGIN_DIR is the value verbatim; the env script needs the
    // Qt root above kwin/plugins.
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk("/usr/lib64/qt6/plugins"), {
        PATHWAY_KWIN_PLUGIN_DIR: "/opt/pathway/qt6/plugins/kwin/plugins",
      }),
    ).toEqual({
      pluginDirectory: "/opt/pathway/qt6/plugins/kwin/plugins",
      qtPluginRoot: "/opt/pathway/qt6/plugins",
    });
    // A directory that is not a kwin/plugins subpath is its own root.
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk(), {
        PATHWAY_KWIN_PLUGIN_DIR: "/opt/elsewhere/",
      }),
    ).toEqual({ pluginDirectory: "/opt/elsewhere", qtPluginRoot: "/opt/elsewhere" });
    // Unset or empty: the normal decision.
    expect(
      resolveInstallTarget(SYSTEM_QT_ROOTS, "/home/x", onDisk(), { PATHWAY_KWIN_PLUGIN_DIR: "" })
        .qtPluginRoot,
    ).toBe("/home/x/.local/lib/qt6/plugins");
  });

  it("never leaves the home directory, which is the whole point of not needing sudo", () => {
    for (const present of [["/usr/lib64/qt6/plugins"], ["/usr/lib/qt6/plugins"], []]) {
      expect(
        resolveInstallTarget(
          SYSTEM_QT_ROOTS,
          "/home/x",
          onDisk(...present),
          cleanEnv,
        ).pluginDirectory.startsWith("/home/x/"),
      ).toBe(true);
    }
  });
});

describe("session env script", () => {
  it("lands where the Plasma session sources it", () => {
    expect(envScriptPath({ XDG_CONFIG_HOME: "/c" }, "/home/x")).toBe(
      `/c/plasma-workspace/env/${ENV_SCRIPT_NAME}`,
    );
    expect(envScriptPath({}, "/home/x")).toBe(
      `/home/x/.config/plasma-workspace/env/${ENV_SCRIPT_NAME}`,
    );
  });

  fsTest("is safe to source twice and keeps any path the user already had", () =>
    Effect.gen(function* () {
      const path = yield* join(yield* temp, "env.sh");
      yield* writeText(path, renderEnvScript("/home/x/.local/lib64/qt6/plugins"));
      const run = (existing: string) =>
        sh(`QT_PLUGIN_PATH='${existing}'; . '${path}'; . '${path}'; printf '%s' "$QT_PLUGIN_PATH"`);

      expect(yield* run("")).toBe("/home/x/.local/lib64/qt6/plugins");
      // Sourced twice, listed once, and the pre-existing entry survives.
      expect(yield* run("/opt/other")).toBe("/home/x/.local/lib64/qt6/plugins:/opt/other");
    }),
  );

  fsTest("rewrites only when the content actually changed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* join(yield* temp, "nested", "env.sh");
      const contents = renderEnvScript("/root");

      expect(yield* ensureEnvScript(path, contents)).toBe("written");
      expect(yield* ensureEnvScript(path, contents)).toBe("unchanged");
      expect(yield* ensureEnvScript(path, renderEnvScript("/other"))).toBe("written");
      expect(yield* readText(path)).toContain("/other");
      // Sourced by the session, so it has to be executable.
      expect((yield* fs.stat(path)).mode & 0o111).toBeTruthy();
    }),
  );

  fsTest("preserves shell metacharacters in the plugin root as literal path characters", () =>
    Effect.gen(function* () {
      const root =
        "/home/$PATHWAY_AUDIT_VARIABLE `printf substituted` $(printf substituted) \"double\" 'single' \\.local/qt6/plugins";
      const script = renderEnvScript(root);
      const result = yield* sh(`${script}\n${script}\nprintf '%s' "$QT_PLUGIN_PATH"`, {
        PATHWAY_AUDIT_VARIABLE: "expanded",
        QT_PLUGIN_PATH: "/opt/existing",
      });
      expect(result).toBe(`${root}:/opt/existing`);
    }),
  );
});

describe("what the running compositor can see", () => {
  it("reads the session's own QT_PLUGIN_PATH, exact entries only", () => {
    const root = "/home/x/.local/lib64/qt6/plugins";
    expect(sessionSeesPluginRoot(root, { QT_PLUGIN_PATH: `/a:${root}:/b` })).toBe(true);
    expect(sessionSeesPluginRoot(root, { QT_PLUGIN_PATH: "" })).toBe(false);
    expect(sessionSeesPluginRoot(root, {})).toBe(false);
    // A prefix is not the directory: /home/x/.local/lib64/qt6/plugins-old is a
    // different place, and treating it as a match would report a plugin as ready
    // to load when KWin has never scanned for it.
    expect(sessionSeesPluginRoot(root, { QT_PLUGIN_PATH: `${root}-old` })).toBe(false);
  });
});

/** Readers over an in-memory /usr, for describing a host without touching this machine's. */
const fakeDisk = (files: Record<string, string>): HostToolchainReaders => ({
  readFile: (path) => files[path],
  listDirectory: (path) =>
    Object.keys(files)
      .filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/"))
      .map((file) => file.slice(path.length + 1)),
});
const noToolchain = fakeDisk({});
/** A host as `selectPrebuilt` sees it, defaulting to "none of the matrix, toolchain unknown". */
const host = (overrides: Partial<PrebuiltHost> = {}): PrebuiltHost => ({
  builtOn: undefined,
  likeBuiltOn: [],
  qtVersion: undefined,
  kfVersion: undefined,
  ...overrides,
});
/** A derivative that tracks Arch's packages verbatim. */
const endeavour = () => ({ id: "endeavouros", versionId: "rolling", idLike: ["arch"] });

describe("prebuilt selection", () => {
  const toolchain = { qtVersion: "6.9.1", kfVersion: "6.17.0" };
  const manifest = {
    builds: [
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "fedora-43" as const,
        file: "fedora.so",
        sha256: "aa",
        ...toolchain,
      },
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "debian-trixie" as const,
        file: "debian.so",
        sha256: "bb",
        ...toolchain,
      },
      {
        kwinVersion: "6.7.3",
        arch: "arm64",
        builtOn: "fedora-43" as const,
        file: "arm.so",
        sha256: "cc",
        ...toolchain,
      },
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "arch" as const,
        file: "arch.so",
        sha256: "dd",
        ...toolchain,
      },
      {
        kwinVersion: "6.7.3",
        arch: "x64",
        builtOn: "opensuse-tumbleweed" as const,
        file: "suse-legacy.so",
        sha256: "ee",
        // A manifest written before the toolchain was recorded.
      },
    ],
  };
  it("takes the host's own distribution build outright", () => {
    expect(selectPrebuilt(manifest, "6.7.3", "x64", host({ builtOn: "fedora-43" }))?.file).toBe(
      "fedora.so",
    );
    expect(selectPrebuilt(manifest, "6.7.3", "x64", host({ builtOn: "debian-trixie" }))?.file).toBe(
      "debian.so",
    );
    expect(selectPrebuilt(manifest, "6.7.3", "arm64", host({ builtOn: "fedora-43" }))?.file).toBe(
      "arm.so",
    );
    // Even without a readable toolchain, and even over a parent's build.
    expect(
      selectPrebuilt(
        manifest,
        "6.7.3",
        "x64",
        host({ builtOn: "debian-trixie", likeBuiltOn: ["arch"] }),
      )?.file,
    ).toBe("debian.so");
  });

  it("never settles for a near miss on KWin or architecture, which fails at load with no reason", () => {
    const fedora = host({ builtOn: "fedora-43", ...toolchain });
    expect(selectPrebuilt(manifest, "6.7.4", "x64", fedora)).toBeUndefined();
    expect(selectPrebuilt(manifest, "6.7", "x64", fedora)).toBeUndefined();
    expect(selectPrebuilt(manifest, "6.7.3", "riscv64", fedora)).toBeUndefined();
  });

  it("crosses distributions only when both Qt and KF match the build exactly", () => {
    // Fedora 44: not in this manifest, so it is a cross-distro host here.
    expect(
      selectPrebuilt(manifest, "6.7.3", "x64", host({ builtOn: "fedora-44", ...toolchain })),
    ).toBeDefined();
    expect(
      selectPrebuilt(manifest, "6.7.3", "x64", host({ ...toolchain, qtVersion: "6.9.2" })),
    ).toBeUndefined();
    expect(
      selectPrebuilt(manifest, "6.7.3", "x64", host({ ...toolchain, kfVersion: "6.18.0" })),
    ).toBeUndefined();
    // Unreadable toolchain on the host: no cross-distro guess at all.
    expect(selectPrebuilt(manifest, "6.7.3", "x64", host())).toBeUndefined();
    expect(selectPrebuilt(manifest, "6.7.3", "x64", host({ qtVersion: "6.9.1" }))).toBeUndefined();
  });

  it("never crosses onto a build that recorded no toolchain", () => {
    const onlyLegacy = {
      builds: manifest.builds.filter((build) => build.file === "suse-legacy.so"),
    };
    expect(selectPrebuilt(onlyLegacy, "6.7.3", "x64", host({ ...toolchain }))).toBeUndefined();
    expect(
      selectPrebuilt(
        onlyLegacy,
        "6.7.3",
        "x64",
        host({ ...toolchain, likeBuiltOn: ["opensuse-tumbleweed"] }),
      ),
    ).toBeUndefined();
    // Its own distribution still gets it.
    expect(
      selectPrebuilt(onlyLegacy, "6.7.3", "x64", host({ builtOn: "opensuse-tumbleweed" }))?.file,
    ).toBe("suse-legacy.so");
  });

  it("prefers a parent named in ID_LIKE among the compatible cross-distro builds", () => {
    // EndeavourOS: ID_LIKE=arch, same packages as Arch.
    expect(
      selectPrebuilt(manifest, "6.7.3", "x64", host({ likeBuiltOn: ["arch"], ...toolchain }))?.file,
    ).toBe("arch.so");
    // Without the hint, the first compatible build in manifest order.
    expect(selectPrebuilt(manifest, "6.7.3", "x64", host({ ...toolchain }))?.file).toBe(
      "fedora.so",
    );
    // A parent whose build does not pass the toolchain check is not taken on
    // the hint alone.
    expect(
      selectPrebuilt(
        manifest,
        "6.7.3",
        "x64",
        host({ likeBuiltOn: ["arch"], qtVersion: "6.9.1", kfVersion: "6.16.0" }),
      ),
    ).toBeUndefined();
  });

  fsTest("keeps the recorded toolchain from the manifest and tolerates its absence", () =>
    Effect.gen(function* () {
      const path = yield* join(yield* temp, "manifest.json");
      yield* writeManifest(path, {
        builds: [
          {
            kwinVersion: "6.7.3",
            arch: "x64",
            builtOn: "fedora-43",
            file: "a.so",
            sha256: "0".repeat(64),
            qtVersion: "6.9.1",
            kfVersion: "6.17.0",
            glibcVersion: "2.41",
          },
          {
            kwinVersion: "6.7.3",
            arch: "x64",
            builtOn: "arch",
            file: "b.so",
            sha256: "1".repeat(64),
            qtVersion: "",
            kfVersion: 6,
          },
        ],
      });
      expect((yield* readPrebuiltManifest(path))?.builds).toEqual([
        {
          kwinVersion: "6.7.3",
          arch: "x64",
          builtOn: "fedora-43",
          file: "a.so",
          sha256: "0".repeat(64),
          qtVersion: "6.9.1",
          kfVersion: "6.17.0",
          glibcVersion: "2.41",
        },
        {
          kwinVersion: "6.7.3",
          arch: "x64",
          builtOn: "arch",
          file: "b.so",
          sha256: "1".repeat(64),
        },
      ]);
    }),
  );

  fsTest("treats a missing or corrupt manifest as no prebuilts, not as a failure", () =>
    Effect.gen(function* () {
      const dir = yield* temp;
      expect(yield* readPrebuiltManifest(yield* join(dir, "absent.json"))).toBeUndefined();
      yield* writeText(yield* join(dir, "bad.json"), "{ not json");
      expect(yield* readPrebuiltManifest(yield* join(dir, "bad.json"))).toBeUndefined();
      yield* writeText(yield* join(dir, "null.json"), "null");
      expect(yield* readPrebuiltManifest(yield* join(dir, "null.json"))).toBeUndefined();

      const legacy = yield* join(dir, "legacy.json");
      yield* writeManifest(legacy, {
        builds: [{ kwinVersion: "6.7.3", arch: "x64", file: "old.so", sha256: "0".repeat(64) }],
      });
      expect(yield* readPrebuiltManifest(legacy)).toBeUndefined();
    }),
  );
});

describe("host description", () => {
  it("reads Qt and KF from the cmake package version files, whichever lib root has them", () => {
    const described = describePrebuiltHost(
      { id: "endeavouros", versionId: "rolling", idLike: ["arch"] },
      fakeDisk({
        "/usr/lib/cmake/Qt6/Qt6ConfigVersion.cmake":
          '# generated\nset(PACKAGE_VERSION "6.9.1")\nif(PACKAGE_FIND_VERSION_RANGE)\n',
        "/usr/lib/cmake/KF6WindowSystem/KF6WindowSystemConfigVersion.cmake":
          'set(PACKAGE_VERSION "6.17.0")\n',
      }),
    );
    expect(described).toEqual({
      builtOn: undefined,
      likeBuiltOn: ["arch"],
      qtVersion: "6.9.1",
      kfVersion: "6.17.0",
    });
  });

  it("falls back to the versioned soname when the development packages are absent", () => {
    const described = describePrebuiltHost(
      { id: "fedora", versionId: "43" },
      fakeDisk({
        "/usr/lib64/libQt6Core.so.6": "",
        "/usr/lib64/libQt6Core.so.6.9.1": "",
        "/usr/lib64/libKF6WindowSystem.so.6.17.0": "",
        "/usr/lib64/cmake/KWin/KWinConfigVersion.cmake": 'set(PACKAGE_VERSION "6.7.3")',
      }),
    );
    expect(described).toEqual({
      builtOn: "fedora-43",
      likeBuiltOn: [],
      qtVersion: "6.9.1",
      kfVersion: "6.17.0",
    });
  });

  it("reports an unreadable toolchain as unknown rather than guessing", () => {
    expect(
      describePrebuiltHost({ id: "nobara", versionId: "43", idLike: ["fedora"] }, noToolchain),
    ).toEqual({
      builtOn: undefined,
      likeBuiltOn: ["fedora-43"],
      qtVersion: undefined,
      kfVersion: undefined,
    });
  });
});

describe("checksum", () => {
  fsTest("hands back the bytes it hashed, and nothing for anything else", () =>
    Effect.gen(function* () {
      const dir = yield* temp;
      const path = yield* join(dir, "plugin.so");
      yield* writeText(path, "binary");
      const wrong = "9d0e05e02e0e5e37f52d5c4c1d1b0d2f0b8f6e0e1a58ba2e6f3e0b2f7bd9b7e2";
      expect(yield* readVerifiedPrebuilt(path, wrong)).toBeUndefined();
      const real = sha256("binary");
      expect(text(yield* readVerifiedPrebuilt(path, real))).toBe("binary");
      expect(yield* readVerifiedPrebuilt(yield* join(dir, "absent.so"), real)).toBeUndefined();
      expect(verifyPrebuiltBytes(bytes("binary"), real)).toBe(true);
      expect(verifyPrebuiltBytes(bytes("binar"), real)).toBe(false);
    }),
  );
});

describe("plugin id", () => {
  fsTest("outranks every installed version, because KWin pins the file it loaded", () =>
    Effect.gen(function* () {
      const stateRoot = yield* join(yield* temp, "state");
      expect(yield* allocatePluginId({ stateRoot, existingFiles: [] })).toBe(
        "PathwayComputerUsePluginV1",
      );
      expect(
        yield* allocatePluginId({
          stateRoot,
          existingFiles: ["PathwayComputerUsePluginV3.so", "PathwayComputerUsePluginV11.so"],
        }),
      ).toBe("PathwayComputerUsePluginV12");
      expect(highestInstalledPluginNumber(["notes.txt", "PathwayComputerUsePlugin.so"])).toBe(0);
      expect(pluginIdNumber("PathwayComputerUsePluginV12")).toBe(12);
      expect(pluginIdNumber("PathwayComputerUsePlugin")).toBe(0);
    }),
  );

  /**
   * The regression: uninstall empties the plugin directory, the next install
   * numbers from the files it sees and starts over at V1, and KWin - which
   * pinned V1 to the library it loaded earlier this session - serves the
   * uninstalled build under the new name.
   */
  fsTest(
    "never reuses a number after the files are gone, because KWin pins ids for the session",
    () =>
      Effect.gen(function* () {
        const stateRoot = yield* join(yield* temp, "state");
        expect(
          yield* allocatePluginId({ stateRoot, existingFiles: ["PathwayComputerUsePluginV4.so"] }),
        ).toBe("PathwayComputerUsePluginV5");
        // Uninstalled: nothing on disk.
        expect(yield* allocatePluginId({ stateRoot, existingFiles: [] })).toBe(
          "PathwayComputerUsePluginV6",
        );
        expect((yield* readText(pluginIdCounterPath(stateRoot))).trim()).toBe("6");
      }),
  );

  fsTest(
    "takes the higher of the counter and the files, so a foreign install still gets outranked",
    () =>
      Effect.gen(function* () {
        const stateRoot = yield* join(yield* temp, "state");
        yield* makeDirectory(stateRoot);
        yield* writeText(pluginIdCounterPath(stateRoot), "3\n");
        expect(
          yield* allocatePluginId({ stateRoot, existingFiles: ["PathwayComputerUsePluginV9.so"] }),
        ).toBe("PathwayComputerUsePluginV10");
        expect(yield* allocatePluginId({ stateRoot, existingFiles: [] })).toBe(
          "PathwayComputerUsePluginV11",
        );
      }),
  );

  fsTest("treats a garbled counter as zero rather than failing the install", () =>
    Effect.gen(function* () {
      const stateRoot = yield* join(yield* temp, "state");
      yield* makeDirectory(stateRoot);
      yield* writeText(pluginIdCounterPath(stateRoot), "not a number");
      expect(yield* allocatePluginId({ stateRoot, existingFiles: [] })).toBe(
        "PathwayComputerUsePluginV1",
      );
      expect(yield* listSorted(stateRoot)).toEqual(["plugin-id.counter"]);
    }),
  );
});

describe("provisioning", () => {
  const baseDeps = (overrides: Partial<ProvisionDependencies> = {}) =>
    Effect.gen(function* () {
      const dir = yield* temp;
      const built = yield* join(dir, "built.so");
      return {
        target: {
          qtPluginRoot: yield* join(dir, "plugins"),
          pluginDirectory: yield* join(dir, "plugins", "kwin", "plugins"),
        },
        env: { XDG_CONFIG_HOME: yield* join(dir, "config") },
        stateRoot: yield* join(dir, "state"),
        listInstalled: Effect.succeed([]),
        kwinVersion: Effect.succeed("6.7.3"),
        runningKwinVersion: Effect.succeed("6.7.3"),
        arch: "x64",
        linuxDistribution: () => ({ id: "fedora", versionId: "43" }),
        hostToolchain: noToolchain,
        buildFromSource: writeText(built, "from source").pipe(Effect.as(built), Effect.orDie),
        isCurrent: () => Effect.succeed(false),
        ...overrides,
      } satisfies ProvisionDependencies;
    });

  /** A prebuilt root holding `file` with `contents`, described by `builds`. */
  const prebuiltRoot = (file: string, contents: string, builds: readonly unknown[]) =>
    Effect.gen(function* () {
      const root = yield* join(yield* temp, "prebuilt");
      yield* makeDirectory(root);
      yield* writeText(yield* join(root, file), contents);
      yield* writeManifest(yield* join(root, "manifest.json"), { builds });
      return root;
    });

  const installed = (deps: ProvisionDependencies, name: string) =>
    Effect.flatMap(join(deps.target.pluginDirectory, name), readText);

  provisioningTest("installs a matching prebuilt without ever invoking the compiler", () =>
    Effect.gen(function* () {
      const root = yield* prebuiltRoot("p.so", "prebuilt bytes", [
        {
          kwinVersion: "6.7.3",
          arch: "x64",
          builtOn: "fedora-43",
          file: "p.so",
          sha256: sha256("prebuilt bytes"),
        },
      ]);
      let built = false;
      const deps = yield* baseDeps({
        prebuiltRoot: root,
        buildFromSource: Effect.sync(() => {
          built = true;
          return "unused";
        }),
      });
      const result = yield* provisionKWinPlugin(deps);

      expect(result.action).toBe("installed-prebuilt");
      expect(built).toBe(false);
      expect(yield* installed(deps, "PathwayComputerUsePluginV1.so")).toBe("prebuilt bytes");
    }),
  );

  provisioningTest("builds from source when no prebuilt matches this KWin", () =>
    Effect.gen(function* () {
      const deps = yield* baseDeps({ kwinVersion: Effect.succeed("6.9.9") });
      const result = yield* provisionKWinPlugin(deps);

      expect(result.action).toBe("installed-from-source");
      expect(yield* installed(deps, "PathwayComputerUsePluginV1.so")).toBe("from source");
    }),
  );

  provisioningTest("reports each stage it reaches (R14)", () =>
    Effect.gen(function* () {
      const stages: string[] = [];
      yield* provisionKWinPlugin(
        yield* baseDeps({
          kwinVersion: Effect.succeed("6.9.9"),
          onStage: (stage) => stages.push(stage),
        }),
      );
      expect(stages).toEqual(["waiting-for-lock", "installing", "building"]);
    }),
  );

  provisioningTest("builds from source rather than using another distro's matching KWin", () =>
    Effect.gen(function* () {
      const root = yield* prebuiltRoot("debian.so", "debian bytes", [
        {
          kwinVersion: "6.7.3",
          arch: "x64",
          builtOn: "debian-trixie",
          file: "debian.so",
          sha256: sha256("debian bytes"),
        },
      ]);
      const result = yield* provisionKWinPlugin(yield* baseDeps({ prebuiltRoot: root }));
      expect(result.action).toBe("installed-from-source");
    }),
  );

  provisioningTest(
    "installs a parent distribution's build on a derivative whose toolchain matches it",
    () =>
      Effect.gen(function* () {
        const root = yield* prebuiltRoot("arch.so", "arch bytes", [
          {
            kwinVersion: "6.7.3",
            arch: "x64",
            builtOn: "arch",
            file: "arch.so",
            sha256: sha256("arch bytes"),
            qtVersion: "6.9.1",
            kfVersion: "6.17.0",
          },
        ]);
        const disk = fakeDisk({
          "/usr/lib/cmake/Qt6/Qt6ConfigVersion.cmake": 'set(PACKAGE_VERSION "6.9.1")',
          "/usr/lib/cmake/KF6WindowSystem/KF6WindowSystemConfigVersion.cmake":
            'set(PACKAGE_VERSION "6.17.0")',
        });
        const matched = yield* provisionKWinPlugin(
          yield* baseDeps({
            prebuiltRoot: root,
            linuxDistribution: endeavour,
            hostToolchain: disk,
          }),
        );
        expect(matched.action).toBe("installed-prebuilt");

        // Same derivative, KF one release ahead of the build: no guess, a source build.
        const drifted = fakeDisk({
          "/usr/lib/cmake/Qt6/Qt6ConfigVersion.cmake": 'set(PACKAGE_VERSION "6.9.1")',
          "/usr/lib/cmake/KF6WindowSystem/KF6WindowSystemConfigVersion.cmake":
            'set(PACKAGE_VERSION "6.18.0")',
        });
        const rebuilt = yield* provisionKWinPlugin(
          yield* baseDeps({
            prebuiltRoot: root,
            linuxDistribution: endeavour,
            hostToolchain: drifted,
          }),
        );
        expect(rebuilt.action).toBe("installed-from-source");
      }),
  );

  provisioningTest("builds from source on an unrecognized host", () =>
    Effect.gen(function* () {
      const deps = yield* baseDeps({
        linuxDistribution: () => ({ id: "nobara", versionId: "43" }),
      });
      expect((yield* provisionKWinPlugin(deps)).action).toBe("installed-from-source");
    }),
  );

  provisioningTest("refuses a prebuilt whose bytes do not match the manifest", () =>
    Effect.gen(function* () {
      const root = yield* prebuiltRoot("p.so", "tampered", [
        {
          kwinVersion: "6.7.3",
          arch: "x64",
          builtOn: "fedora-43",
          file: "p.so",
          // Well-formed but wrong: this is the mismatch case, not the
          // malformed-entry case.
          sha256: "0".repeat(64),
        },
      ]);
      // Not silently downgraded to a source build: a checksum failure means the
      // shipped file is wrong, and that is worth stopping over.
      const error = yield* failureOf(provisionKWinPlugin(yield* baseDeps({ prebuiltRoot: root })));
      expect(error).toBeInstanceOf(ComputerBackendError);
      expect(error.message).toMatch(/failed its checksum/);
      expect(error.message).toContain("Reinstalling Pathway");
    }),
  );

  provisioningTest(
    "says a login is needed only when the running session cannot see the directory",
    () =>
      Effect.gen(function* () {
        const deps = yield* baseDeps();
        const first = yield* provisionKWinPlugin(deps);
        expect(first.requiresRelogin).toBe(true);
        expect(first.summary).toMatch(/Log out and back in/);

        const seen = yield* provisionKWinPlugin({
          ...deps,
          env: { ...deps.env, QT_PLUGIN_PATH: deps.target.qtPluginRoot },
        });
        expect(seen.requiresRelogin).toBe(false);
        expect(seen.summary).not.toMatch(/Log out/);
      }),
  );

  provisioningTest(
    "never asks for a login when the backend vouches for the compositor's view",
    () =>
      Effect.gen(function* () {
        // The nested backend spawns its compositor with the plugin root injected,
        // so the session environment this server inherited proves nothing.
        const result = yield* provisionKWinPlugin(
          yield* baseDeps({ compositorSeesPluginRoot: () => true }),
        );
        expect(result.requiresRelogin).toBe(false);
        expect(result.summary).not.toMatch(/Log out/);
      }),
  );

  provisioningTest("writes the env script even when the plugin is already current", () =>
    Effect.gen(function* () {
      const deps = yield* baseDeps({ isCurrent: () => Effect.succeed(true) });
      const result = yield* provisionKWinPlugin(deps);

      expect(result.action).toBe("already-current");
      expect(result.pluginId).toBeUndefined();
      // The script is what makes any install visible at all, so a user who deleted
      // it gets it back on the next enable rather than a plugin KWin never scans.
      expect(yield* readText(envScriptPath(deps.env, "/unused"))).toContain(
        deps.target.qtPluginRoot,
      );
    }),
  );

  provisioningTest(
    "still asks for the login when a current install is one the session cannot see",
    () =>
      Effect.gen(function* () {
        const hidden = yield* baseDeps({ isCurrent: () => Effect.succeed(true) });
        const seen = yield* provisionKWinPlugin({
          ...hidden,
          env: { ...hidden.env, QT_PLUGIN_PATH: "/tmp/elsewhere" },
        });
        expect(seen.requiresRelogin).toBe(true);
        expect(seen.summary).toMatch(/installed and current\. Log out/);

        const deps = yield* baseDeps({ isCurrent: () => Effect.succeed(true) });
        const visible = yield* provisionKWinPlugin({
          ...deps,
          env: { ...deps.env, QT_PLUGIN_PATH: deps.target.qtPluginRoot },
        });
        expect(visible.requiresRelogin).toBe(false);
        expect(visible.summary).not.toMatch(/Log out/);
      }),
  );

  provisioningTest(
    "reinstalls past a current stamp when forced, which is what a refusal needs",
    () =>
      Effect.gen(function* () {
        let built = 0;
        const deps = yield* baseDeps({ isCurrent: () => Effect.succeed(true) });
        const result = yield* provisionKWinPlugin({
          ...deps,
          force: true,
          buildFromSource: Effect.andThen(
            Effect.sync(() => {
              built += 1;
            }),
            deps.buildFromSource,
          ),
        });

        expect(result.action).toBe("installed-from-source");
        expect(result.pluginId).toBe("PathwayComputerUsePluginV1");
        expect(built).toBe(1);
      }),
  );

  provisioningTest(
    "records the KWin version it installed for, so a later refusal can name it",
    () =>
      Effect.gen(function* () {
        const deps = yield* baseDeps();
        yield* provisionKWinPlugin(deps);
        const stamp = yield* readText(installStampPath(deps.stateRoot));

        expect(stamp).toContain("plugin_id=PathwayComputerUsePluginV1");
        expect(stamp).toContain("kwin_version=6.7.3");
        expect(stamp).toContain("linux_distribution=fedora:43:");
        // Absent on purpose: the shell installer treats a missing signature as
        // "rebuild", which is the right answer for a stamp it did not write.
        expect(stamp).not.toContain("signature=");
      }),
  );

  fsTest("serializes an unknown distro identity into direct install stamps", () =>
    Effect.gen(function* () {
      const dir = yield* temp;
      const path = yield* join(dir, "install.stamp");
      yield* writeInstallStamp(path, {
        pluginId: "PathwayComputerUsePluginV2",
        pluginPath: yield* join(dir, "plugin.so"),
        kwinVersion: "6.7.3",
        linuxDistribution: { id: "custom:linux", versionId: "1", versionCodename: "edge" },
        installedAt: "2026-09-10T00:00:00.000Z",
      });
      expect(yield* readText(path)).toContain("linux_distribution=custom%3Alinux:1:edge\n");
    }),
  );

  /**
   * The regression: pruning inside provisioning deleted the working build
   * before the replacement had been loaded, so a refused load (a KWin upgrade
   * the running compositor has not picked up yet, a bad build) left the user
   * with nothing. The old file now outlives the install until the backend
   * has proven the new one works and prunes explicitly.
   */
  provisioningTest(
    "leaves the build it supersedes on disk; the backend prunes after the load succeeds",
    () =>
      Effect.gen(function* () {
        const deps = yield* baseDeps();
        yield* makeDirectory(deps.target.pluginDirectory);
        yield* writeText(
          yield* join(deps.target.pluginDirectory, "PathwayComputerUsePluginV4.so"),
          "old",
        );
        yield* writeText(yield* join(deps.target.pluginDirectory, "keep-me.txt"), "unrelated");

        const result = yield* provisionKWinPlugin({
          ...deps,
          listInstalled: Effect.succeed(["PathwayComputerUsePluginV4.so"]),
        });

        expect(result.pluginId).toBe("PathwayComputerUsePluginV5");
        expect(result.pluginDirectory).toBe(deps.target.pluginDirectory);
        expect(yield* listSorted(deps.target.pluginDirectory)).toEqual(
          [
            ".pathway-provision.lock",
            "PathwayComputerUsePluginV4.so",
            "PathwayComputerUsePluginV5.so",
            "keep-me.txt",
          ].toSorted(),
        );
        // What the backend does once V5 has passed its health check.
        expect(yield* pruneSupersededPlugins(result.pluginDirectory, result.pluginId!)).toEqual([
          "PathwayComputerUsePluginV4.so",
        ]);
      }),
  );

  provisioningTest(
    "stops the compiler when setup is cancelled mid-build, and installs nothing",
    () =>
      Effect.gen(function* () {
        const building = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const deps = yield* baseDeps({
          buildFromSource: Deferred.succeed(building, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
          ),
        });
        const run = yield* Effect.forkChild(provisionKWinPlugin(deps), { startImmediately: true });
        yield* Deferred.await(building);

        yield* Fiber.interrupt(run);
        expect(Exit.hasInterrupts(yield* Fiber.await(run))).toBe(true);
        yield* Deferred.await(stopped);
        expect(yield* listSorted(deps.target.pluginDirectory)).toEqual([".pathway-provision.lock"]);
      }),
  );

  provisioningTest(
    "asks whether the install is current for the on-disk KWin, never the running one",
    () =>
      Effect.gen(function* () {
        const asked: (string | undefined)[] = [];
        const deps = yield* baseDeps({
          kwinVersion: Effect.succeed("6.8.0"),
          runningKwinVersion: Effect.succeed("6.7.3"),
          isCurrent: (version) =>
            Effect.sync(() => {
              asked.push(version);
              return true;
            }),
        });
        const result = yield* provisionKWinPlugin(deps);
        expect(asked).toEqual(["6.8.0"]);
        expect(result.action).toBe("already-current");
        // Current for the KWin that starts next login, not loadable by this one.
        expect(result.requiresRelogin).toBe(true);
        expect(result.summary).toContain("6.8.0");
      }),
  );

  /**
   * The regression: after a KWin package upgrade without a relogin, the
   * on-disk version moved but the compositor in front of the user did not.
   * Provisioning installed for the new version, pruned the working build,
   * the load was refused by the old compositor, and every reconnect then
   * forced a source build. Now: install for the on-disk version, keep the
   * running build, and say the install waits for the next login.
   */
  provisioningTest(
    "installs for an upgraded on-disk KWin without touching the build the session is running",
    () =>
      Effect.gen(function* () {
        const root = yield* prebuiltRoot("new.so", "for 6.8.0", [
          {
            kwinVersion: "6.8.0",
            arch: "x64",
            builtOn: "fedora-43",
            file: "new.so",
            sha256: sha256("for 6.8.0"),
          },
        ]);
        let built = false;
        const deps = yield* baseDeps({
          prebuiltRoot: root,
          kwinVersion: Effect.succeed("6.8.0"),
          runningKwinVersion: Effect.succeed("6.7.3"),
          buildFromSource: Effect.sync(() => {
            built = true;
            return "unused";
          }),
        });
        yield* makeDirectory(deps.target.pluginDirectory);
        yield* writeText(
          yield* join(deps.target.pluginDirectory, "PathwayComputerUsePluginV4.so"),
          "running",
        );
        const visibleEnv = { ...deps.env, QT_PLUGIN_PATH: deps.target.qtPluginRoot };

        const result = yield* provisionKWinPlugin({ ...deps, env: visibleEnv });

        expect(result.action).toBe("installed-prebuilt");
        expect(built).toBe(false);
        expect(result.pluginId).toBe("PathwayComputerUsePluginV5");
        // Visible to the session, and still not loadable by it.
        expect(result.requiresRelogin).toBe(true);
        expect(result.summary).toContain("6.8.0");
        expect(yield* installed(deps, "PathwayComputerUsePluginV4.so")).toBe("running");
        expect(yield* installed(deps, "PathwayComputerUsePluginV5.so")).toBe("for 6.8.0");
        expect(yield* readText(installStampPath(deps.stateRoot))).toContain("kwin_version=6.8.0");
        // The backend prunes below the id it just loaded and health-checked - V4,
        // the one this session runs - and V5 waits for the next login untouched.
        expect(
          yield* pruneSupersededPlugins(result.pluginDirectory, "PathwayComputerUsePluginV4"),
        ).toEqual([]);
        expect(yield* listSorted(deps.target.pluginDirectory)).toEqual(
          [
            ".pathway-provision.lock",
            "PathwayComputerUsePluginV4.so",
            "PathwayComputerUsePluginV5.so",
          ].toSorted(),
        );
      }),
  );

  provisioningTest("does not call the upgrade pending when either version is unknown", () =>
    Effect.gen(function* () {
      const deps = yield* baseDeps({
        kwinVersion: Effect.succeed("6.8.0"),
        runningKwinVersion: Effect.succeed(undefined),
      });
      const result = yield* provisionKWinPlugin({
        ...deps,
        env: { ...deps.env, QT_PLUGIN_PATH: deps.target.qtPluginRoot },
      });
      expect(result.requiresRelogin).toBe(false);
    }),
  );

  provisioningTest("keeps the version suffix climbing past what is already installed", () =>
    Effect.gen(function* () {
      const deps = yield* baseDeps({
        listInstalled: Effect.succeed(["PathwayComputerUsePluginV4.so"]),
      });
      const result = yield* provisionKWinPlugin(deps);
      expect(result.pluginId).toBe("PathwayComputerUsePluginV5");
    }),
  );
});

describe("prune", () => {
  fsTest("survives a directory that does not exist yet", () =>
    Effect.gen(function* () {
      const absent = yield* join(yield* temp, "absent");
      expect(yield* pruneSupersededPlugins(absent, "PathwayComputerUsePluginV1")).toEqual([]);
    }),
  );

  fsTest(
    "removes only builds numbered below the kept id, never the one waiting for next login",
    () =>
      Effect.gen(function* () {
        const dir = yield* temp;
        for (const name of [
          "PathwayComputerUsePluginV3.so",
          "PathwayComputerUsePluginV4.so",
          "PathwayComputerUsePluginV5.so",
          "PathwayComputerUsePluginV6.so",
          "PathwayComputerUsePlugin.so",
          "notes.txt",
        ]) {
          yield* writeText(yield* join(dir, name), name);
        }
        const removed = yield* pruneSupersededPlugins(dir, "PathwayComputerUsePluginV5");
        expect(removed.toSorted()).toEqual([
          "PathwayComputerUsePluginV3.so",
          "PathwayComputerUsePluginV4.so",
        ]);
        expect(yield* listSorted(dir)).toEqual(
          [
            "PathwayComputerUsePlugin.so",
            "PathwayComputerUsePluginV5.so",
            "PathwayComputerUsePluginV6.so",
            "notes.txt",
          ].toSorted(),
        );
      }),
  );
});

describe("installed binary", () => {
  fsTest("is executable, named for its id, and leaves no staging file behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* join(yield* temp, "a", "b");
      const destination = yield* installPluginBytes(
        bytes("bytes"),
        directory,
        "PathwayComputerUsePluginV9",
      );
      expect(destination).toBe(yield* join(directory, "PathwayComputerUsePluginV9.so"));
      expect((yield* fs.stat(destination)).mode & 0o111).toBeTruthy();
      expect(yield* readText(destination)).toBe("bytes");
      // The bytes go through a sibling .tmp and a rename, so a reader that lists
      // the directory afterwards sees only the finished file.
      expect(yield* listSorted(directory)).toEqual(["PathwayComputerUsePluginV9.so"]);
    }),
  );

  fsTest("refuses to overwrite an id that is already on disk", () =>
    Effect.gen(function* () {
      const dir = yield* temp;
      yield* installPluginBytes(bytes("first"), dir, "PathwayComputerUsePluginV3");
      const error = yield* failureOf(
        installPluginBytes(bytes("second"), dir, "PathwayComputerUsePluginV3"),
      );
      expect(error.message).toMatch(/existing plugin build/);
      expect(yield* readText(yield* join(dir, "PathwayComputerUsePluginV3.so"))).toBe("first");
      expect(yield* listSorted(dir)).toEqual(["PathwayComputerUsePluginV3.so"]);
    }),
  );
});
