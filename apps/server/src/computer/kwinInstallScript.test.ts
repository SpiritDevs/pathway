/**
 * The KWin installer script (native/computer-use-kwin/scripts/install-and-load.sh)
 * run for real under bash, in a sandbox whose cmake, busctl and kwin_wayland
 * are stubs: a fake KWin install tree stands in for /usr, and a stub session
 * bus stands in for the compositor's plugin interface.
 *
 * Linux only: the script and the sandbox's allowlist lean on util-linux and
 * GNU coreutils (`flock`, `sha256sum`, `stat -c`).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import {
  makeInstallScriptSandbox,
  type InstallScriptSandbox,
} from "./installScriptSandbox.testkit.ts";

const isLinux = process.platform === "linux";

const PLUGIN_SOURCE_FILES = [
  "CMakeLists.txt",
  "metadata.json",
  "main.cpp",
  "pathwaycomputeruseplugin.h",
  "computeruseauth.h",
  "pathwaycomputeruseplugin.cpp",
  "pathwaycomputerusebuildinfo.h.in",
  "scripts/install-and-load.sh",
] as const;

interface FakeKwinTree {
  readonly libraryRoot: string;
  readonly includeRoot: string;
}

interface FakeKwinTreeOptions {
  readonly dependencies?: readonly string[];
  readonly headers?: readonly string[];
  readonly libkwin?: boolean;
}

/**
 * A sandbox with cmake, ninja, busctl and kwin_wayland stubbed, and the
 * helpers each test builds its fixture from.
 */
const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginSource = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "native",
    "computer-use-kwin",
  );
  /** Stub cmake and busctl, kept as shell files next to the plugin's other tests. */
  const stubs = path.join(pluginSource, "tests", "install-script-stubs");
  const sandbox: InstallScriptSandbox = yield* makeInstallScriptSandbox;
  yield* sandbox.stub("cmake", yield* fs.readFileString(path.join(stubs, "cmake")));
  yield* sandbox.stub("ninja", "exit 0");
  yield* sandbox.stub("busctl", yield* fs.readFileString(path.join(stubs, "busctl")));
  // Aborts outside a real compositor start on some hosts (and dumps core):
  // the installer must never need it.
  yield* sandbox.stub("kwin_wayland", "exit 134");

  /** A copy of the plugin sources, as an AppImage mounts them per launch. */
  const sourceCopy = (name: string) =>
    Effect.gen(function* () {
      const directory = path.join(sandbox.root, name);
      yield* Effect.forEach(
        PLUGIN_SOURCE_FILES,
        (file) =>
          fs
            .makeDirectory(path.dirname(path.join(directory, file)), { recursive: true })
            .pipe(
              Effect.andThen(
                fs.copyFile(path.join(pluginSource, file), path.join(directory, file)),
              ),
            ),
        { discard: true },
      );
      return directory;
    });

  const fakeKwinTree = (options: FakeKwinTreeOptions = {}) =>
    Effect.gen(function* () {
      const libraryRoot = path.join(sandbox.root, "sysroot", "usr", "lib");
      const includeRoot = path.join(sandbox.root, "sysroot", "usr", "include");
      const dependencies = options.dependencies ?? [
        "ECM",
        "Qt6Core",
        "Wayland",
        "epoxy",
        "Libdrm",
        "Vulkan",
      ];
      const headers = options.headers ?? [
        "xkbcommon/xkbcommon.h",
        "vulkan/vulkan.h",
        "epoxy/gl.h",
        "xf86drm.h",
        "wayland-server.h",
      ];
      yield* fs.makeDirectory(path.join(libraryRoot, "cmake", "KWin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(libraryRoot, "cmake", "KWin", "KWinConfig.cmake"),
        [
          "include(CMakeFindDependencyMacro)",
          ...dependencies.map((name) =>
            name === "Wayland"
              ? "find_dependency(Wayland REQUIRED Server)"
              : `find_dependency(${name})`,
          ),
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(libraryRoot, "cmake", "KWin", "KWinConfigVersion.cmake"),
        'set(PACKAGE_VERSION "6.7.4")\n',
      );
      yield* fs.writeFileString(path.join(libraryRoot, "libvulkan.so"), "");
      if (options.libkwin ?? true) {
        yield* fs.writeFileString(path.join(libraryRoot, "libkwin.so.6.7.4"), "");
        yield* fs.symlink("libkwin.so.6.7.4", path.join(libraryRoot, "libkwin.so.6"));
      }
      for (const header of headers) {
        yield* fs.makeDirectory(path.dirname(path.join(includeRoot, header)), { recursive: true });
        yield* fs.writeFileString(path.join(includeRoot, header), "");
      }
      return { libraryRoot, includeRoot } satisfies FakeKwinTree;
    });

  const scriptEnv = (tree: FakeKwinTree): Record<string, string> => ({
    PATHWAY_KWIN_LIBRARY_ROOTS: tree.libraryRoot,
    PATHWAY_KWIN_INCLUDE_ROOTS: tree.includeRoot,
    PATHWAY_KWIN_PLUGIN_DIR: path.join(sandbox.home, "plugins"),
  });

  const stateRoot = path.join(
    sandbox.home,
    ".local",
    "state",
    "pathway",
    "kwin-computer-use-plugin",
  );
  const buildRoot = path.join(
    sandbox.home,
    ".cache",
    "pathway",
    "kwin-computer-use-plugin",
    "build",
  );
  const installer = (source: string) => path.join(source, "scripts", "install-and-load.sh");
  const read = (file: string) => fs.readFileString(file);
  const write = (file: string, text: string) => fs.writeFileString(file, text);
  const callsStartingWith = (prefix: string) =>
    Effect.map(sandbox.calls, (calls) => calls.filter((call) => call.startsWith(prefix)));

  return {
    sandbox,
    path,
    sourceCopy,
    fakeKwinTree,
    scriptEnv,
    stateRoot,
    buildRoot,
    installer,
    read,
    write,
    callsStartingWith,
  };
});

type Harness = Effect.Success<typeof harness>;

/** Runs one test against a fresh harness, removed afterwards. Linux only. */
const installerTest = (
  name: string,
  body: (h: Harness) => Effect.Effect<void, PlatformError.PlatformError>,
) =>
  it.live.skipIf(!isLinux)(name, () =>
    harness.pipe(Effect.flatMap(body), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

describe("KWin install-and-load.sh", () => {
  describe("build dependency check (R14)", () => {
    installerTest("names a header KWin's cmake config needs before running cmake", (h) =>
      Effect.gen(function* () {
        const source = yield* h.sourceCopy("source");
        const tree = yield* h.fakeKwinTree({
          headers: ["xkbcommon/xkbcommon.h", "epoxy/gl.h", "xf86drm.h", "wayland-server.h"],
        });

        const result = yield* h.sandbox.run(
          h.installer(source),
          ["--build-only"],
          h.scriptEnv(tree),
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("vulkan/vulkan.h");
        expect(result.stderr).toContain("KWinConfig.cmake");
        expect(yield* h.callsStartingWith("cmake")).toEqual([]);
      }),
    );

    installerTest("only asks for Vulkan when this KWin's config depends on it", (h) =>
      Effect.gen(function* () {
        const source = yield* h.sourceCopy("source");
        const tree = yield* h.fakeKwinTree({
          dependencies: ["ECM", "Qt6Core", "Wayland", "epoxy", "Libdrm"],
          headers: ["xkbcommon/xkbcommon.h", "epoxy/gl.h", "xf86drm.h", "wayland-server.h"],
        });

        const result = yield* h.sandbox.run(
          h.installer(source),
          ["--build-only"],
          h.scriptEnv(tree),
        );

        expect(result.stderr).not.toContain("ERROR");
        expect(result.status).toBe(0);
        expect(result.stdout.trim().split("\n").at(-1)).toMatch(
          /\/build\/kwin\/plugins\/PathwayComputerUsePlugin\.so$/,
        );
      }),
    );
  });

  describe("KWin version probe", () => {
    installerTest(
      "reads the installed KWin version off libkwin's soname, never running kwin_wayland",
      (h) =>
        Effect.gen(function* () {
          const source = yield* h.sourceCopy("source");
          const tree = yield* h.fakeKwinTree();

          const result = yield* h.sandbox.run(h.installer(source), [], h.scriptEnv(tree));

          expect(result.stderr).not.toContain("ERROR");
          expect(result.status).toBe(0);
          expect(yield* h.read(h.path.join(h.stateRoot, "install.stamp"))).toContain(
            "kwin_version=6.7.4\n",
          );
          expect(yield* h.callsStartingWith("kwin_wayland")).toEqual([]);
        }),
    );

    installerTest(
      "falls back to KWin's cmake package version when there is no libkwin symlink",
      (h) =>
        Effect.gen(function* () {
          const source = yield* h.sourceCopy("source");
          const tree = yield* h.fakeKwinTree({ libkwin: false });
          yield* h.write(
            h.path.join(tree.libraryRoot, "cmake", "KWin", "KWinConfigVersion.cmake"),
            'set(PACKAGE_VERSION "6.5.1")\n',
          );

          const result = yield* h.sandbox.run(h.installer(source), [], h.scriptEnv(tree));

          expect(result.status).toBe(0);
          expect(yield* h.read(h.path.join(h.stateRoot, "install.stamp"))).toContain(
            "kwin_version=6.5.1\n",
          );
          expect(yield* h.callsStartingWith("kwin_wayland")).toEqual([]);
        }),
    );
  });

  describe("rebuild timer on an unchanged install (P2)", () => {
    const pluginCalls = (h: Harness) =>
      Effect.map(h.sandbox.calls, (calls) =>
        calls.filter((call) => /\b(Unload|Load)Plugin\b/.test(call)),
      );

    installerTest("leaves the loaded plugin alone when nothing changed", (h) =>
      Effect.gen(function* () {
        const source = yield* h.sourceCopy("source");
        const tree = yield* h.fakeKwinTree();
        const script = h.installer(source);
        expect((yield* h.sandbox.run(script, [], h.scriptEnv(tree))).status).toBe(0);
        const installed = /^plugin_id=(.*)$/m.exec(
          yield* h.read(h.path.join(h.stateRoot, "install.stamp")),
        )?.[1];
        expect(installed).toMatch(/^PathwayComputerUsePluginV\d+$/);
        const before = (yield* pluginCalls(h)).length;

        // What the timer's service runs every six hours.
        const rerun = yield* h.sandbox.run(script, [], h.scriptEnv(tree));

        expect(rerun.status).toBe(0);
        expect(rerun.stdout).toContain("nothing to do");
        expect((yield* pluginCalls(h)).slice(before)).toEqual([]);
        expect(yield* h.read(h.path.join(h.sandbox.stubState, "loaded"))).toBe(`${installed}\n`);
        expect(yield* h.callsStartingWith("cmake")).toHaveLength(2);
      }),
    );

    installerTest("still loads the installed plugin when the compositor is not running it", (h) =>
      Effect.gen(function* () {
        const source = yield* h.sourceCopy("source");
        const tree = yield* h.fakeKwinTree();
        const script = h.installer(source);
        expect((yield* h.sandbox.run(script, [], h.scriptEnv(tree))).status).toBe(0);
        // A KWin restart that did not pick the plugin up again.
        yield* h.write(h.path.join(h.sandbox.stubState, "loaded"), "");

        const rerun = yield* h.sandbox.run(script, [], h.scriptEnv(tree));

        expect(rerun.status).toBe(0);
        expect(rerun.stdout).toContain("signature is unchanged");
        expect((yield* h.read(h.path.join(h.sandbox.stubState, "loaded"))).trim()).toMatch(
          /^PathwayComputerUsePluginV\d+$/,
        );
      }),
    );

    installerTest("replaces a loaded plugin that is not the installed one", (h) =>
      Effect.gen(function* () {
        const source = yield* h.sourceCopy("source");
        const tree = yield* h.fakeKwinTree();
        const script = h.installer(source);
        expect((yield* h.sandbox.run(script, [], h.scriptEnv(tree))).status).toBe(0);
        const loaded = h.path.join(h.sandbox.stubState, "loaded");
        const installed = (yield* h.read(loaded)).trim();
        yield* h.write(loaded, `${installed}\nPathwayComputerUsePlugin\n`);

        const rerun = yield* h.sandbox.run(script, [], h.scriptEnv(tree));

        expect(rerun.status).toBe(0);
        expect(rerun.stdout).not.toContain("nothing to do");
        expect(yield* h.read(loaded)).toBe(`${installed}\n`);
      }),
    );
  });

  describe("build cache across source directories (P2, AppImage)", () => {
    installerTest(
      "builds again when the same build directory was configured from another mount",
      (h) =>
        Effect.gen(function* () {
          // An AppImage mounts its payload at a new path on every launch, while the
          // build directory lives in the user's cache and persists.
          const firstLaunch = yield* h.sourceCopy("mount-first");
          const secondLaunch = yield* h.sourceCopy("mount-second");
          const tree = yield* h.fakeKwinTree();

          const first = yield* h.sandbox.run(
            h.installer(firstLaunch),
            ["--build-only"],
            h.scriptEnv(tree),
          );
          const second = yield* h.sandbox.run(
            h.installer(secondLaunch),
            ["--build-only"],
            h.scriptEnv(tree),
          );

          expect(first.status).toBe(0);
          expect(second.stderr).not.toContain("does not match the source");
          expect(second.status).toBe(0);
          expect(yield* h.read(h.path.join(h.buildRoot, "CMakeCache.txt"))).toContain(
            `CMAKE_HOME_DIRECTORY:INTERNAL=${secondLaunch}\n`,
          );
        }),
    );

    installerTest("keeps the cache when the source directory is unchanged", (h) =>
      Effect.gen(function* () {
        const source = yield* h.sourceCopy("source");
        const tree = yield* h.fakeKwinTree();
        const script = h.installer(source);
        const marker = h.path.join(h.buildRoot, "CMakeFiles", "marker");

        expect((yield* h.sandbox.run(script, ["--build-only"], h.scriptEnv(tree))).status).toBe(0);
        yield* h.write(marker, "");
        expect((yield* h.sandbox.run(script, ["--build-only"], h.scriptEnv(tree))).status).toBe(0);

        expect(yield* h.read(marker)).toBe("");
      }),
    );
  });
});
