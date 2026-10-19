import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { SpawnExecutableResolution } from "@spiritdevs/shared/shell";
import * as ExternalLauncher from "./externalLauncher.ts";

function makeMockDetachedHandle(onUnref: () => void = () => undefined) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      onUnref();
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const testLayer = (input: {
  readonly platform: NodeJS.Platform;
  readonly env?: Record<string, string>;
  readonly resolveExecutable?: (command: string) => string | undefined;
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
  readonly onUnref?: () => void;
}) => {
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        assert.equal(ChildProcess.isStandardCommand(command), true);
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("Expected a standard command");
        }
        input.onSpawn?.(command);
        return makeMockDetachedHandle(input.onUnref);
      }),
    ),
  );

  return Layer.mergeAll(
    ExternalLauncher.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, spawnerLayer))),
    Layer.succeed(HostProcessPlatform, input.platform),
    Layer.succeed(
      SpawnExecutableResolution,
      (command) => input.resolveExecutable?.(command) ?? command,
    ),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
  );
};

it.effect("launches the default browser through the platform command", () => {
  let spawned: ChildProcess.StandardCommand | undefined;
  let didUnref = false;
  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    yield* launcher.launchBrowser("https://example.com/some path");

    assert.ok(spawned);
    assert.equal(spawned.command, "xdg-open");
    assert.deepEqual(spawned.args, ["https://example.com/some path"]);
    assert.equal(spawned.options.detached, true);
    assert.equal(didUnref, true);
  }).pipe(
    Effect.provide(
      testLayer({
        platform: "linux",
        onSpawn: (command) => {
          spawned = command;
        },
        onUnref: () => {
          didUnref = true;
        },
      }),
    ),
  );
});

it.effect("launches an installed editor with platform-safe arguments", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pathway-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "code.CMD"), "@echo off\r\n");

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.launchEditor({
        editor: "vscode",
        cwd: "C:\\workspace with spaces\\src\\index.ts:12:4",
      });
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
          resolveExecutable: (command) =>
            command === "code" ? "C:\\Program Files\\Microsoft VS Code\\bin\\code.CMD" : command,
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, '^"C:\\Program^ Files\\Microsoft^ VS^ Code\\bin\\code.CMD^"');
    assert.deepEqual(spawned.args, [
      '^"--goto^"',
      '^"C:\\workspace^ with^ spaces\\src\\index.ts:12:4^"',
    ]);
    assert.equal(spawned.options.shell, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("discovers editors through the service API", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pathway-editors-" });
    yield* fileSystem.writeFileString(path.join(binDir, "code.CMD"), "@echo off\r\n");
    yield* fileSystem.writeFileString(path.join(binDir, "explorer.CMD"), "@echo off\r\n");

    const editors = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher.resolveAvailableEditors();
    }).pipe(
      Effect.provide(
        testLayer({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        }),
      ),
    );

    assert.equal(editors.includes("vscode"), true);
    assert.equal(editors.includes("file-manager"), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("memoizes editor discovery and refreshes after the cache window", () => {
  let statCalls = 0;
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.sync(() => {
              statCalls += 1;
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    const first = yield* launcher.resolveAvailableEditors();
    assert.equal(first.includes("vscode"), true);
    const statCallsAfterFirstScan = statCalls;
    assert.isAbove(statCallsAfterFirstScan, 0);

    // Past the shared command-resolution cache TTL (30s) but within the
    // discovery cache window: the memoized set is reused without any scan.
    yield* TestClock.adjust("31 seconds");
    const second = yield* launcher.resolveAvailableEditors();
    assert.deepEqual([...second], [...first]);
    assert.equal(statCalls, statCallsAfterFirstScan);

    // Past the discovery cache window the next call rescans.
    yield* TestClock.adjust("30 seconds");
    yield* launcher.resolveAvailableEditors();
    assert.isAbove(statCalls, statCallsAfterFirstScan);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PATH: "C:\\pathway-editor-discovery-cache-test",
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ),
        TestClock.layer(),
      ),
    ),
  );
});

// Discovery scans park inside `stat` until `gate` opens. `firstPathStats`
// counts visits to the first probed path, so a restarted scan shows up as a
// second visit. Each launcher gets its own PATH so the process-wide command
// resolution cache in @spiritdevs/shared/shell never answers for it.
let gatedDiscoveryCount = 0;
const gatedDiscovery = (gate: Deferred.Deferred<void>, entered: Deferred.Deferred<void>) => {
  gatedDiscoveryCount += 1;
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const counts = { firstPathStats: 0 };
  let firstPath: string | null = null;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: (path) =>
            Effect.gen(function* () {
              firstPath ??= path;
              if (path === firstPath) {
                counts.firstPathStats += 1;
              }
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(gate);
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );
  const layer = Layer.mergeAll(
    launcherLayer,
    Layer.succeed(HostProcessPlatform, "win32"),
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          PATH: `C:\\pathway-editor-discovery-gated-${gatedDiscoveryCount}`,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      }),
    ),
    TestClock.layer(),
  );
  return { counts, layer };
};

it.effect("serves an editor snapshot without waiting for discovery, then publishes it", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const { counts, layer } = gatedDiscovery(gate, entered);
    return yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      // Every caller gets the empty snapshot at once and shares one scan.
      assert.deepEqual([...(yield* launcher.availableEditorsSnapshot)], []);
      assert.deepEqual([...(yield* launcher.availableEditorsSnapshot)], []);
      const discovered = yield* launcher.availableEditorsChanges.pipe(
        Stream.filter((editors) => editors.length > 0),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* Deferred.succeed(gate, undefined);
      const published = Option.getOrThrow(yield* Fiber.join(discovered));
      assert.equal(published.includes("vscode"), true);
      assert.deepEqual([...(yield* launcher.availableEditorsSnapshot)], [...published]);
      assert.equal(counts.firstPathStats, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps the last snapshot while an expired one refreshes", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const { counts, layer } = gatedDiscovery(gate, entered);
    yield* Deferred.succeed(gate, undefined);
    return yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      const first = yield* launcher.resolveAvailableEditors();
      assert.equal(first.includes("vscode"), true);

      yield* TestClock.adjust("61 seconds");
      const stale = yield* launcher.availableEditorsSnapshot;
      assert.deepEqual([...stale], [...first]);
      const refreshed = yield* launcher.resolveAvailableEditors();
      assert.deepEqual([...refreshed], [...first]);
      assert.equal(counts.firstPathStats, 2);
    }).pipe(Effect.provide(layer));
  }),
);

// A client that disconnects mid-connect must neither cancel the shared scan nor
// leave a poisoned result behind: the next caller joins the same scan.
it.effect("a caller interrupted mid-scan does not cancel or restart the shared scan", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const { counts, layer } = gatedDiscovery(gate, entered);
    return yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      const abandoned = yield* Effect.forkChild(launcher.resolveAvailableEditors());
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(abandoned);

      const next = yield* Effect.forkChild(launcher.resolveAvailableEditors());
      yield* Deferred.succeed(gate, undefined);
      const editors = yield* Fiber.join(next);
      assert.equal(editors.includes("vscode"), true);
      assert.equal(counts.firstPathStats, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("rejects unknown editors through the service API", () =>
  Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const error = yield* launcher
      .launchEditor({ editor: "missing-editor" as never, cwd: "/tmp/workspace" })
      .pipe(Effect.flip);
    assert.instanceOf(error, ExternalLauncher.ExternalLauncherUnknownEditorError);
    assert.equal(error.editor, "missing-editor");
    assert.equal(error.message, "Unknown editor: missing-editor");
  }).pipe(Effect.provide(testLayer({ platform: "linux", env: { PATH: "" } }))),
);

for (const scenario of [
  {
    platform: "darwin",
    editor: "terminal",
    command: "open",
    args: ["-a", "Terminal", "/workspace with spaces"],
  },
  {
    platform: "darwin",
    editor: "ghostty",
    command: "open",
    args: ["-a", "Ghostty", "/workspace with spaces"],
  },
  {
    platform: "linux",
    editor: "ghostty",
    command: "ghostty",
    args: ["--working-directory=/workspace with spaces"],
  },
  { platform: "linux", editor: "terminal", command: "x-terminal-emulator", args: [] },
  { platform: "win32", editor: "terminal", command: "wt", args: ["-d", "/workspace with spaces"] },
] as const) {
  it.effect(`opens ${scenario.editor} on ${scenario.platform} without shell interpolation`, () => {
    let spawned: ChildProcess.StandardCommand | undefined;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-terminal-" });
      const executable = path.join(
        binDir,
        scenario.command + (scenario.platform === "win32" ? ".EXE" : ""),
      );
      yield* fs.writeFileString(executable, "");
      yield* fs.chmod(executable, 0o755);
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchEditor({ editor: scenario.editor, cwd: "/workspace with spaces" });
        assert.ok(spawned);
        assert.equal(spawned.command, scenario.command);
        assert.deepEqual(spawned.args, scenario.args);
        assert.equal(spawned.options.shell, false);
        if (scenario.platform === "linux" && scenario.editor === "terminal") {
          assert.equal(spawned.options.cwd, "/workspace with spaces");
        }
      }).pipe(
        Effect.provide(
          testLayer({
            platform: scenario.platform,
            env: { PATH: binDir, PATHEXT: ".EXE" },
            onSpawn: (command) => {
              spawned = command;
            },
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  });
}
