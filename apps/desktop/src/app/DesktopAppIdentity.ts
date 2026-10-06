import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;

const AppPackageMetadata = Schema.Struct({
  pathwayCommitHash: Schema.optional(Schema.String),
});
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));

const RuntimeAppIdentity = Schema.Struct({
  userDataDirName: Schema.NonEmptyString,
  legacyUserDataDirName: Schema.NonEmptyString,
});
const decodeRuntimeAppIdentity = Schema.decodeEffect(Schema.fromJsonString(RuntimeAppIdentity));

export class DesktopRuntimeAppIdentityReadError extends Schema.TaggedErrorClass<DesktopRuntimeAppIdentityReadError>()(
  "DesktopRuntimeAppIdentityReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to read the packaged runtime identity at "${this.path}".`;
  }
}

export class DesktopUserDataPathResolutionError extends Schema.TaggedErrorClass<DesktopUserDataPathResolutionError>()(
  "DesktopUserDataPathResolutionError",
  {
    legacyPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to inspect legacy desktop user-data path at "${this.legacyPath}".`;
  }
}

export class DesktopAppIdentity extends Context.Service<
  DesktopAppIdentity,
  {
    readonly resolveUserDataPath: Effect.Effect<
      string,
      DesktopUserDataPathResolutionError | DesktopRuntimeAppIdentityReadError
    >;
    readonly configure: Effect.Effect<void>;
  }
>()("@spiritdevs/desktop/app/DesktopAppIdentity") {}

const normalizeCommitHash = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return COMMIT_HASH_PATTERN.test(trimmed)
    ? Option.some(trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase())
    : Option.none();
};

export const resolveUserDataPath = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const electronApp = yield* ElectronApp.ElectronApp;
  if (electronApp.isPathwayRuntime && (yield* electronApp.hasCommandLineSwitch("user-data-dir"))) {
    return yield* electronApp.userDataPath;
  }
  let identity = {
    userDataDirName: environment.userDataDirName,
    legacyUserDataDirName: environment.legacyUserDataDirName,
  };
  if (electronApp.isPathwayRuntime) {
    const identityPath = environment.path.join(
      environment.resourcesPath,
      "pathway-runtime-app.json",
    );
    const stampedIdentity = yield* Effect.gen(function* () {
      if (!(yield* fileSystem.exists(identityPath))) return undefined;
      return yield* fileSystem
        .readFileString(identityPath)
        .pipe(Effect.flatMap(decodeRuntimeAppIdentity));
    }).pipe(
      Effect.mapError(
        (cause) => new DesktopRuntimeAppIdentityReadError({ path: identityPath, cause }),
      ),
    );
    if (stampedIdentity) identity = stampedIdentity;
  }
  const legacyPath = environment.path.join(
    environment.appDataDirectory,
    identity.legacyUserDataDirName,
  );
  const legacyPathExists = yield* fileSystem.exists(legacyPath).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopUserDataPathResolutionError({
          legacyPath,
          cause,
        }),
    ),
  );
  const resolvedPath = legacyPathExists
    ? legacyPath
    : environment.path.join(environment.appDataDirectory, identity.userDataDirName);
  if (electronApp.isPathwayRuntime) {
    const runtimePath = yield* electronApp.userDataPath;
    if (runtimePath !== resolvedPath) {
      yield* Effect.logError(
        `Pathway runtime userData path drift: runtime app.getPath('userData') is "${runtimePath}", but the desktop resolved "${resolvedPath}" before app.setPath. Chrome's Profile root must match the packaged identity.`,
      );
    }
  }
  return resolvedPath;
}).pipe(Effect.withSpan("desktop.appIdentity.resolveUserDataPath"));

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const commitHashCache = yield* Ref.make<Option.Option<Option.Option<string>>>(Option.none());

  const resolveEmbeddedCommitHash = Effect.gen(function* () {
    const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
    const raw = yield* fileSystem.readFileString(packageJsonPath).pipe(Effect.option);
    return yield* Option.match(raw, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (value) =>
        decodeAppPackageMetadata(value).pipe(
          Effect.map((parsed) =>
            Option.fromNullishOr(parsed.pathwayCommitHash).pipe(
              Option.flatMap(normalizeCommitHash),
            ),
          ),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    });
  });

  const resolveAboutCommitHash = Effect.gen(function* () {
    const cached = yield* Ref.get(commitHashCache);
    if (Option.isSome(cached)) {
      return cached.value;
    }

    const override = Option.flatMap(environment.commitHashOverride, normalizeCommitHash);
    if (Option.isSome(override)) {
      yield* Ref.set(commitHashCache, Option.some(override));
      return override;
    }

    if (!environment.isPackaged) {
      const empty = Option.none<string>();
      yield* Ref.set(commitHashCache, Option.some(empty));
      return empty;
    }

    const commitHash = yield* resolveEmbeddedCommitHash;
    yield* Ref.set(commitHashCache, Option.some(commitHash));
    return commitHash;
  });

  const userDataPath = resolveUserDataPath.pipe(
    Effect.provide(
      yield* Effect.context<
        DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem | ElectronApp.ElectronApp
      >(),
    ),
  );

  const configure = Effect.gen(function* () {
    const commitHash = yield* resolveAboutCommitHash;
    yield* electronApp.setName(environment.displayName);
    yield* electronApp.setAboutPanelOptions({
      applicationName: environment.displayName,
      applicationVersion: environment.appVersion,
      version: Option.getOrElse(commitHash, () => "unknown"),
    });

    if (environment.platform === "win32") {
      yield* electronApp.setAppUserModelId(environment.appUserModelId);
    }
  }).pipe(Effect.withSpan("desktop.appIdentity.configure"));

  return DesktopAppIdentity.of({
    resolveUserDataPath: userDataPath,
    configure,
  });
});

export const layer = Layer.effect(DesktopAppIdentity, make);
