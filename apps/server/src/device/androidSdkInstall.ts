/**
 * One-click Android setup for the local device host.
 *
 * Installs whatever the emulator path still lacks into the SDK the host already
 * uses (or the platform's default SDK location): the pinned Command-line Tools,
 * then Platform-Tools, the Emulator and a system image through sdkmanager, and
 * finally one virtual device when none exist. sdkmanager needs Java 17+, so an
 * existing JDK (JAVA_HOME, Android Studio's bundled JBR, the system Java) is
 * preferred and a Temurin JRE is downloaded into Pathway's cache only as a last
 * resort. Each step is skipped when its result is already present, so retrying
 * after a failure resumes rather than starts over.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

/** Pinned like the other device tools; bump with the SHA-1 from Google's repository2 manifest. */
const COMMAND_LINE_TOOLS_BUILD = "16111833";
const COMMAND_LINE_TOOLS: Record<string, { readonly file: string; readonly sha1: string }> = {
  "darwin-arm64": {
    file: `commandlinetools-mac_arm64-${COMMAND_LINE_TOOLS_BUILD}_latest.zip`,
    sha1: "ad03dc49bfacfd52c110b14104ea548b8a07e830",
  },
  "darwin-x64": {
    file: `commandlinetools-mac_x86_64-${COMMAND_LINE_TOOLS_BUILD}_latest.zip`,
    sha1: "112cf9618794a997ff273537d55bee02c22abffe",
  },
  linux: {
    file: `commandlinetools-linux-${COMMAND_LINE_TOOLS_BUILD}_latest.zip`,
    sha1: "e025545c62a8e64c7559119566a569fb1dec5f60",
  },
};
const MIN_JAVA_MAJOR = 17;
const AVD_DEVICE = "pixel_9";
const DOWNLOAD_TIMEOUT = Duration.minutes(30);
const SDK_INSTALL_TIMEOUT = Duration.minutes(60);

export class AndroidSdkInstallError extends Schema.TaggedErrorClass<AndroidSdkInstallError>()(
  "AndroidSdkInstallError",
  {
    /** User-facing; shown in the setup UI as-is. */
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Hosts the installer supports. Windows SDK installs stay manual. */
export const canInstallAndroidSdk = (platform: NodeJS.Platform, arch: string) =>
  platform === "linux" ? arch === "x64" : platform === "darwin";

export const defaultAndroidSdkRoot = (path: Path.Path, platform: NodeJS.Platform, home: string) =>
  platform === "darwin"
    ? path.join(home, "Library", "Android", "sdk")
    : path.join(home, "Android", "Sdk");

export interface AndroidSdkState {
  readonly adb: boolean;
  readonly emulator: boolean;
  readonly avdmanager: boolean;
  readonly avdCount: number;
}

/** The steps still needed, in order. Empty when the emulator path is complete. */
export function planAndroidSdkInstall(
  state: AndroidSdkState,
  target: { readonly apiLevel: string; readonly arch: string },
) {
  const systemImage = `system-images;android-${target.apiLevel};google_apis;${target.arch === "arm64" ? "arm64-v8a" : "x86_64"}`;
  const createAvd = state.avdCount === 0;
  return {
    commandLineTools: !state.avdmanager,
    packages: [
      ...(state.adb ? [] : ["platform-tools"]),
      ...(state.emulator ? [] : ["emulator"]),
      ...(createAvd ? [systemImage] : []),
    ],
    avd: createAvd
      ? { name: `Pixel_9_API_${target.apiLevel}`, systemImage, device: AVD_DEVICE }
      : null,
  };
}

/** Major version from a JDK `release` file; "1.8.0" style versions are Java 8. */
export function javaMajorFromRelease(release: string): number | null {
  const version = /^JAVA_VERSION="([^"]+)"/m.exec(release)?.[1];
  if (!version) return null;
  const [first, second] = version.split(".").map((part) => Number.parseInt(part, 10));
  const major = first === 1 ? second : first;
  return major !== undefined && Number.isFinite(major) ? major : null;
}

export const installAndroidSdk = Effect.fn("AndroidSdkInstall.install")(function* (input: {
  readonly sdkRoot: string | null;
  readonly apiLevel: string;
  readonly cacheDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly onProgress: (detail: string) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const home = input.environment.HOME ?? "";
  const root = input.sdkRoot ?? defaultAndroidSdkRoot(path, input.platform, home);
  const fail = (reason: string) => (cause: unknown) =>
    new AndroidSdkInstallError({ reason, cause });
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const run = (
    reason: string,
    command: string,
    args: ReadonlyArray<string>,
    options: { env?: NodeJS.ProcessEnv; stdin?: string; timeout?: Duration.Input } = {},
  ) =>
    runner
      .run({
        command,
        args,
        env: options.env ?? input.environment,
        stdin: options.stdin,
        timeout: options.timeout ?? Duration.minutes(2),
        maxOutputBytes: 256 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError(fail(reason)),
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result)
            : Effect.fail(
                new AndroidSdkInstallError({
                  reason,
                  cause: new Error(result.stderr.trim() || result.stdout.trim().slice(-2000)),
                }),
              ),
        ),
      );
  const download = (reason: string, url: string, file: string) =>
    run(reason, "curl", ["-fsSL", "--retry", "3", "-o", file, url], {
      timeout: DOWNLOAD_TIMEOUT,
    });

  // Unpack beside the destination: renames across filesystems (a tmpfs /tmp) fail.
  const stagingBeside = (destination: string, reason: string) => {
    const staging = `${destination}.staging`;
    return fs
      .remove(staging, { recursive: true, force: true })
      .pipe(
        Effect.andThen(fs.makeDirectory(staging, { recursive: true })),
        Effect.as(staging),
        Effect.mapError(fail(reason)),
      );
  };
  const replaceWith = (source: string, destination: string, reason: string) =>
    fs
      .remove(destination, { recursive: true, force: true })
      .pipe(
        Effect.andThen(fs.rename(source, destination)),
        Effect.andThen(fs.remove(`${destination}.staging`, { recursive: true, force: true })),
        Effect.mapError(fail(reason)),
      );

  const avdHome =
    input.environment.ANDROID_AVD_HOME ??
    path.join(input.environment.ANDROID_USER_HOME ?? path.join(home, ".android"), "avd");
  const avdCount = (yield* fs.readDirectory(avdHome).pipe(Effect.orElseSucceed(() => []))).filter(
    (name) => name.endsWith(".ini"),
  ).length;
  const bin = (dir: string, name: string) => path.join(root, dir, name);
  const sdkmanager = bin(path.join("cmdline-tools", "latest", "bin"), "sdkmanager");
  const plan = planAndroidSdkInstall(
    {
      adb: yield* exists(bin("platform-tools", "adb")),
      emulator: yield* exists(bin("emulator", "emulator")),
      avdmanager: yield* exists(bin(path.join("cmdline-tools", "latest", "bin"), "avdmanager")),
      avdCount,
    },
    { apiLevel: input.apiLevel, arch: input.arch },
  );
  if (!plan.commandLineTools && plan.packages.length === 0 && !plan.avd) return;

  const work = yield* fs
    .makeTempDirectory({ prefix: "pathway-android-" })
    .pipe(Effect.mapError(fail("Couldn't create a temporary directory.")));
  yield* Effect.gen(function* () {
    yield* input.onProgress("Finding Java…");
    const javaHome = yield* resolveJavaHome(input, work);

    if (plan.commandLineTools) {
      const archive =
        COMMAND_LINE_TOOLS[input.platform === "darwin" ? `darwin-${input.arch}` : input.platform];
      if (!archive)
        return yield* new AndroidSdkInstallError({
          reason: "Android SDK setup isn't supported on this machine.",
        });
      yield* input.onProgress("Downloading Android SDK Command-line Tools…");
      const zip = path.join(work, archive.file);
      yield* download(
        "Couldn't download Android SDK Command-line Tools. Check this machine's network connection.",
        `https://dl.google.com/android/repository/${archive.file}`,
        zip,
      );
      const sha1 = yield* run(
        "Couldn't verify the Command-line Tools download.",
        input.platform === "darwin" ? "shasum" : "sha1sum",
        [zip],
      );
      if (sha1.stdout.split(/\s/)[0] !== archive.sha1)
        return yield* new AndroidSdkInstallError({
          reason: "The Command-line Tools download didn't match its checksum. Try again.",
        });
      const latest = path.join(root, "cmdline-tools", "latest");
      const staging = yield* stagingBeside(
        latest,
        `Couldn't install Command-line Tools into ${root}.`,
      );
      yield* run("Couldn't unpack Android SDK Command-line Tools.", "unzip", [
        "-q",
        zip,
        "-d",
        staging,
      ]);
      yield* replaceWith(
        path.join(staging, "cmdline-tools"),
        latest,
        `Couldn't install Command-line Tools into ${root}.`,
      );
    }

    const env = { ...input.environment, JAVA_HOME: javaHome, ANDROID_HOME: root };
    if (plan.packages.length > 0) {
      const labels = plan.packages.map((name) =>
        name === "platform-tools"
          ? "Platform-Tools"
          : name === "emulator"
            ? "the Android Emulator"
            : `an Android ${input.apiLevel} system image`,
      );
      const large = plan.packages.some((name) => name !== "platform-tools");
      yield* input.onProgress(
        `Downloading ${new Intl.ListFormat("en", { type: "conjunction" }).format(labels)}${large ? ". This can take several minutes…" : "…"}`,
      );
      // Licenses are accepted on the user's behalf; they chose to install from setup.
      yield* run(
        "Couldn't install Android SDK packages. Check this machine's network connection.",
        sdkmanager,
        [`--sdk_root=${root}`, "--install", ...plan.packages],
        { env, stdin: "y\n".repeat(20), timeout: SDK_INSTALL_TIMEOUT },
      );
    }

    if (plan.avd) {
      yield* input.onProgress("Creating an Android virtual device…");
      yield* run(
        "Couldn't create an Android virtual device.",
        bin(path.join("cmdline-tools", "latest", "bin"), "avdmanager"),
        [
          "create",
          "avd",
          "--name",
          plan.avd.name,
          "--package",
          plan.avd.systemImage,
          "--device",
          plan.avd.device,
        ],
        // Declines avdmanager's custom hardware profile prompt.
        { env, stdin: "no\n" },
      );
    }
  }).pipe(Effect.ensuring(fs.remove(work, { recursive: true, force: true }).pipe(Effect.ignore)));

  /** An installed JDK or JRE new enough for sdkmanager, downloading one only when none exists. */
  function resolveJavaHome(
    context: typeof input,
    work: string,
  ): Effect.Effect<string, AndroidSdkInstallError> {
    return Effect.gen(function* () {
      const usable = (javaHome: string) =>
        fs.readFileString(path.join(javaHome, "release")).pipe(
          Effect.map((release) => (javaMajorFromRelease(release) ?? 0) >= MIN_JAVA_MAJOR),
          Effect.orElseSucceed(() => false),
        );
      const managed = path.join(context.cacheDir, "android", "jre");
      const candidates = [
        context.environment.JAVA_HOME,
        ...(context.platform === "darwin"
          ? [
              "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
              path.join(
                home,
                "Applications",
                "Android Studio.app",
                "Contents",
                "jbr",
                "Contents",
                "Home",
              ),
            ]
          : ["/opt/android-studio/jbr", path.join(home, "android-studio", "jbr")]),
      ];
      if (context.platform === "darwin") {
        const system = yield* run("", "/usr/libexec/java_home", ["-v", `${MIN_JAVA_MAJOR}+`]).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.orElseSucceed(() => ""),
        );
        candidates.push(system);
      } else {
        for (const directory of (context.environment.PATH ?? "").split(":")) {
          if (!directory) continue;
          const java = yield* fs.realPath(path.join(directory, "java")).pipe(Effect.option);
          if (java._tag === "Some") candidates.push(path.dirname(path.dirname(java.value)));
        }
      }
      candidates.push(
        context.platform === "darwin" ? path.join(managed, "Contents", "Home") : managed,
      );
      for (const candidate of candidates)
        if (candidate && (yield* usable(candidate))) return candidate;

      yield* context.onProgress("Downloading a Java runtime for the Android SDK tools…");
      const archive = path.join(work, "jre.tar.gz");
      const os = context.platform === "darwin" ? "mac" : "linux";
      const arch = context.arch === "arm64" ? "aarch64" : "x64";
      yield* download(
        "Couldn't download a Java runtime. Install a JDK 17 or newer, then try again.",
        `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/jre/hotspot/normal/eclipse`,
        archive,
      );
      const extracted = yield* stagingBeside(managed, "Couldn't install the Java runtime.");
      yield* run("Couldn't unpack the Java runtime.", "tar", [
        "-xzf",
        archive,
        "-C",
        extracted,
        "--strip-components",
        "1",
      ]);
      yield* replaceWith(extracted, managed, "Couldn't install the Java runtime.");
      const javaHome =
        context.platform === "darwin" ? path.join(managed, "Contents", "Home") : managed;
      if (!(yield* usable(javaHome)))
        return yield* new AndroidSdkInstallError({
          reason:
            "The downloaded Java runtime isn't usable. Install a JDK 17 or newer, then try again.",
        });
      return javaHome;
    });
  }
});
