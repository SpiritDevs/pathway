import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/Pathway.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/Pathway.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

type TestEnvironmentInput = Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> & {
  readonly env?: Record<string, string | undefined>;
};

interface ElectronAppCalls {
  readonly setAboutPanelOptions: Array<Electron.AboutPanelOptionsOptions>;
  readonly setName: string[];
}

const makeElectronAppLayer = (
  calls: ElectronAppCalls,
  isPathwayRuntime = false,
  runtimeUserDataPath = "/Users/alice/Library/Application Support/pathway",
  hasUserDataDirSwitch = false,
) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    isPathwayRuntime,
    userDataPath: Effect.succeed(runtimeUserDataPath),
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("Pathway"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: (name) =>
      Effect.sync(() => {
        calls.setName.push(name);
      }),
    setAboutPanelOptions: (options) =>
      Effect.sync(() => {
        calls.setAboutPanelOptions.push(options);
      }),
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    hasCommandLineSwitch: (name) => {
      assert.equal(name, "user-data-dir");
      return Effect.succeed(hasUserDataDirSwitch);
    },
    onBeforeQuitForUpdate: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

const makeEnvironmentLayer = (overrides: TestEnvironmentInput = {}) => {
  const { env, ...environmentOverrides } = overrides;
  return DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...environmentOverrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          ...env,
        }),
      ),
    ),
  );
};

const withIdentity = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopAppIdentity.DesktopAppIdentity
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
  >,
  input: {
    readonly calls?: ElectronAppCalls;
    readonly environment?: TestEnvironmentInput;
    readonly legacyPathExists?: boolean;
    readonly legacyPathProbeError?: PlatformError.PlatformError;
    readonly packageJson?: string;
    readonly isPathwayRuntime?: boolean;
    readonly runtimeIdentity?: string | undefined;
    readonly runtimeUserDataPath?: string;
    readonly hasUserDataDirSwitch?: boolean;
    readonly probedPaths?: string[];
  } = {},
) => {
  const calls: ElectronAppCalls = input.calls ?? {
    setAboutPanelOptions: [],
    setName: [],
  };

  return effect.pipe(
    Effect.provide(
      DesktopAppIdentity.layer.pipe(
        Layer.provideMerge(
          FileSystem.layerNoop({
            exists: (path) => {
              input.probedPaths?.push(path);
              return path.endsWith("/pathway-runtime-app.json")
                ? Effect.succeed(input.runtimeIdentity !== undefined)
                : input.legacyPathProbeError
                  ? Effect.fail(input.legacyPathProbeError)
                  : Effect.succeed(
                      input.legacyPathExists === true && path.includes("Pathway (Alpha)"),
                    );
            },
            readFileString: (path) =>
              Effect.succeed(
                path.endsWith("/pathway-runtime-app.json")
                  ? (input.runtimeIdentity ?? "")
                  : (input.packageJson ?? '{"pathwayCommitHash":"abcdef1234567890"}'),
              ),
          }),
        ),
        Layer.provideMerge(
          makeElectronAppLayer(
            calls,
            input.isPathwayRuntime,
            input.runtimeUserDataPath,
            input.hasUserDataDirSwitch,
          ),
        ),
        Layer.provideMerge(makeEnvironmentLayer(input.environment)),
      ),
    ),
  );
};

describe("DesktopAppIdentity", () => {
  it.effect.each([false, true])(
    "honors an explicit user-data-dir only on the runtime (runtime: %s)",
    (isPathwayRuntime) => {
      const probedPaths: string[] = [];
      const messages: unknown[] = [];
      const logger = Logger.make((options) => {
        messages.push(options.message);
      });
      return withIdentity(
        Effect.gen(function* () {
          const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
          assert.equal(
            yield* identity.resolveUserDataPath,
            isPathwayRuntime
              ? "/isolated/runtime-profile"
              : "/Users/alice/Library/Application Support/Pathway (Alpha)",
          );
          assert.equal(messages.length, 0);
          if (isPathwayRuntime) assert.deepEqual(probedPaths, []);
        }),
        {
          isPathwayRuntime,
          hasUserDataDirSwitch: true,
          runtimeUserDataPath: "/isolated/runtime-profile",
          runtimeIdentity: JSON.stringify({
            userDataDirName: "pathway",
            legacyUserDataDirName: "Pathway (Alpha)",
          }),
          legacyPathExists: true,
          probedPaths,
        },
      ).pipe(Effect.provide(Logger.layer([logger])));
    },
  );

  it.effect.each([false, true])(
    "uses the runtime release stamp in development with legacy path present: %s",
    (legacyPathExists) =>
      withIdentity(
        Effect.gen(function* () {
          const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
          assert.equal(
            yield* identity.resolveUserDataPath,
            `/Users/alice/Library/Application Support/${legacyPathExists ? "Pathway (Alpha)" : "pathway"}`,
          );
        }),
        {
          environment: { env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } },
          isPathwayRuntime: true,
          runtimeIdentity: JSON.stringify({
            userDataDirName: "pathway",
            legacyUserDataDirName: "Pathway (Alpha)",
          }),
          runtimeUserDataPath: `/Users/alice/Library/Application Support/${legacyPathExists ? "Pathway (Alpha)" : "pathway"}`,
          legacyPathExists,
        },
      ),
  );

  it.effect("uses the cua stamp regardless of the development URL", () =>
    withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        assert.equal(
          yield* identity.resolveUserDataPath,
          "/Users/alice/Library/Application Support/pathway-cua",
        );
      }),
      {
        environment: { flavor: "cua", env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } },
        isPathwayRuntime: true,
        runtimeIdentity: JSON.stringify({
          userDataDirName: "pathway-cua",
          legacyUserDataDirName: "pathway-cua",
        }),
        runtimeUserDataPath: "/Users/alice/Library/Application Support/pathway-cua",
      },
    ),
  );

  it.effect.each([false, true])(
    "preserves development identity without an applicable stamp (runtime: %s)",
    (isPathwayRuntime) => {
      const probedPaths: string[] = [];
      return withIdentity(
        Effect.gen(function* () {
          const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
          assert.equal(
            yield* identity.resolveUserDataPath,
            "/Users/alice/Library/Application Support/pathway-dev",
          );
          assert.equal(
            probedPaths.some((path) => path.endsWith("/pathway-runtime-app.json")),
            isPathwayRuntime,
          );
        }),
        {
          environment: { env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } },
          isPathwayRuntime,
          runtimeIdentity: isPathwayRuntime
            ? undefined
            : JSON.stringify({
                userDataDirName: "pathway",
                legacyUserDataDirName: "Pathway (Alpha)",
              }),
          runtimeUserDataPath: "/Users/alice/Library/Application Support/pathway-dev",
          probedPaths,
        },
      );
    },
  );

  it.effect("fails clearly on a corrupt runtime identity", () =>
    withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const error = yield* identity.resolveUserDataPath.pipe(Effect.flip);
        assert.instanceOf(error, DesktopAppIdentity.DesktopRuntimeAppIdentityReadError);
        assert.include(error.message, "pathway-runtime-app.json");
      }),
      { isPathwayRuntime: true, runtimeIdentity: "{}" },
    ),
  );

  it.effect.each([false, true])(
    "reports path drift only on the runtime (runtime: %s)",
    (isPathwayRuntime) => {
      const messages: unknown[] = [];
      const logger = Logger.make((options) => {
        messages.push(options.message);
      });
      return withIdentity(
        Effect.gen(function* () {
          const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
          assert.equal(
            yield* identity.resolveUserDataPath,
            "/Users/alice/Library/Application Support/pathway",
          );
          const logged = messages.flat().join("\n");
          if (isPathwayRuntime) {
            assert.include(logged, "Pathway runtime userData path drift");
            assert.include(logged, "/runtime/wrong-root");
            assert.include(logged, "/Users/alice/Library/Application Support/pathway");
            assert.include(logged, "before app.setPath");
          } else assert.equal(messages.length, 0);
        }),
        { isPathwayRuntime, runtimeUserDataPath: "/runtime/wrong-root" },
      ).pipe(Effect.provide(Logger.layer([logger])));
    },
  );

  it.effect("keeps using the legacy userData path when it already exists", () =>
    withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const userDataPath = yield* identity.resolveUserDataPath;

        assert.equal(userDataPath, "/Users/alice/Library/Application Support/Pathway (Alpha)");
      }),
      { legacyPathExists: true },
    ),
  );

  it.effect("preserves failures while inspecting the legacy userData path", () => {
    const legacyPath = "/Users/alice/Library/Application Support/Pathway (Alpha)";
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "exists",
      description: "permission denied",
      pathOrDescriptor: legacyPath,
    });

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const error = yield* identity.resolveUserDataPath.pipe(Effect.flip);

        assert.instanceOf(error, DesktopAppIdentity.DesktopUserDataPathResolutionError);
        assert.equal(error.legacyPath, legacyPath);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          `Failed to inspect legacy desktop user-data path at "${legacyPath}".`,
        );
      }),
      { legacyPathProbeError: cause },
    );
  });

  it.effect("configures app identity from the environment commit override", () => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        assert.deepEqual(calls.setName, ["Pathway (Alpha)"]);
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, "Pathway (Alpha)");
        assert.equal(calls.setAboutPanelOptions[0]?.applicationVersion, "1.2.3");
        assert.equal(calls.setAboutPanelOptions[0]?.version, "0123456789ab");
      }),
      {
        calls,
        environment: {
          env: {
            PATHWAY_COMMIT_HASH: "0123456789abcdef",
          },
        },
      },
    );
  });
});
