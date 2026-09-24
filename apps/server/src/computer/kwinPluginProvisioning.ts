// @effect-diagnostics nodeBuiltinImport:off - the install target is decided synchronously off the disk and home directory, as the installer script decides it.
/**
 * Getting the KWin plugin onto a machine that has never seen it.
 *
 * The bar is that a user installs the update, turns computer use on, and it
 * works. Two things stood between us and that, and this module is the answer to
 * both.
 *
 * The first was `sudo`. A KWin plugin does not have to live in `/usr`: KWin
 * finds plugins through Qt's library paths, and Qt reads `QT_PLUGIN_PATH` from
 * the environment. So the plugin goes under the user's own `~/.local`, and one
 * small script in the Plasma session's env directory puts that root on the path.
 * Nothing outside the home directory is touched, and uninstalling is deleting
 * two paths.
 *
 * The second was the compiler. A KWin plugin is a binary module tied to the
 * exact KWin it was built against, so the old flow needed cmake, ninja, and the
 * KWin development headers on the user's machine - which almost nobody has.
 * Prebuilt binaries shipped with the app cover the KWin versions we build for,
 * and building from source stays as the fallback for everything else.
 *
 * The one cost that cannot be engineered away: Qt reads `QT_PLUGIN_PATH` when
 * KWin starts, so the very first install lands in a directory the running
 * compositor was never told about. That session cannot see it, and there is no
 * way to add a library path to a process from outside it. The user logs out once
 * and never thinks about it again - every later update loads live, because the
 * path is already there.
 *
 * @module computer/kwinPluginProvisioning
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ComputerBackendError } from "./computerErrors.ts";
import { withProvisioningFileLock } from "./provisioning/fileLock.ts";
import {
  readHostToolchainVersions,
  type HostToolchainReaders,
} from "./provisioning/hostToolchain.ts";
import {
  detectLinuxDistribution,
  linuxDistributionIdentity,
  prebuiltBuiltOnForDistribution,
  prebuiltBuiltOnLikeDistribution,
  type KWinPrebuiltBuiltOn,
  type LinuxDistribution,
} from "./provisioning/linuxDistribution.ts";
import {
  isPrebuiltBinaryRecord,
  readVerifiedPrebuilt,
  verifyPrebuiltBytes,
} from "./provisioning/prebuiltVerification.ts";

/**
 * The env script's name, which is also the uninstall instruction: this file and
 * the plugin directory are the only two things provisioning creates.
 */
export const ENV_SCRIPT_NAME = "pathway-computer-use.sh";

/** The Qt plugin subpath KWin scans, relative to a Qt plugin root. */
const KWIN_PLUGIN_SUBPATH = join("kwin", "plugins");

export interface InstallTarget {
  /** Where the `.so` goes. */
  readonly pluginDirectory: string;
  /** What `QT_PLUGIN_PATH` has to contain for KWin to scan the directory above. */
  readonly qtPluginRoot: string;
}

/**
 * Where a user-owned plugin goes on this machine.
 *
 * The lib64/lib split is read off the system Qt rather than guessed from the
 * architecture: it is a distro packaging choice (Fedora and openSUSE use lib64,
 * Debian and Arch use lib), and the answer is already sitting on disk in the
 * form of whichever system plugin root exists.
 *
 * Which is why the candidate roots are probed on disk rather than pattern
 * matched: the caller passes both spellings, so testing the list's text would
 * answer "lib64" on every machine in existence, including the Debian and Arch
 * ones that have no /usr/lib64 at all. scripts/install-and-load.sh makes the
 * same decision with `[[ -d /usr/lib64/qt6/plugins ]]`, and the two have to
 * agree or a script install and an app install put the plugin in different
 * directories — only one of which is on the QT_PLUGIN_PATH the env script wrote.
 *
 * `PATHWAY_KWIN_PLUGIN_DIR` overrides the whole decision, exactly as it does in
 * the script: the plugin directory is the value as given, and the Qt plugin
 * root the env script advertises is that value with a trailing `kwin/plugins`
 * stripped when present - the directory KWin scans is always `<root>/kwin/plugins`,
 * so a value that does not end that way is its own root and KWin will not find
 * it, which is the operator's call to make.
 */
export function resolveInstallTarget(
  systemQtRoots: readonly string[],
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): InstallTarget {
  const configured = env.PATHWAY_KWIN_PLUGIN_DIR;
  if (configured) {
    const pluginDirectory = configured.replace(/\/+$/, "") || configured;
    const suffix = `/${KWIN_PLUGIN_SUBPATH}`;
    return {
      pluginDirectory,
      qtPluginRoot: pluginDirectory.endsWith(suffix)
        ? pluginDirectory.slice(0, -suffix.length)
        : pluginDirectory,
    };
  }
  const present = systemQtRoots.find((root) => exists(root));
  const lib = present?.includes("/lib64/") ? "lib64" : "lib";
  const qtPluginRoot = join(home, ".local", lib, "qt6", "plugins");
  return { qtPluginRoot, pluginDirectory: join(qtPluginRoot, KWIN_PLUGIN_SUBPATH) };
}

/** The Plasma session sources every `*.sh` here before it starts the compositor. */
export function envScriptPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "plasma-workspace", "env", ENV_SCRIPT_NAME);
}

/**
 * Prepends, and only when absent, so the script is safe to source twice and
 * never grows the variable without bound. It also stays correct if the user
 * later sets `QT_PLUGIN_PATH` themselves for unrelated reasons.
 */
export function renderEnvScript(qtPluginRoot: string): string {
  return [
    "#!/bin/sh",
    "# Written by Pathway so KWin can find the computer-use plugin in your home",
    "# directory instead of /usr. Delete this file and the directory below to",
    "# undo it; nothing else on the system was changed.",
    `pathway_plugin_root='${qtPluginRoot.replace(/'/g, "'\\''")}'`,
    'case ":${QT_PLUGIN_PATH}:" in',
    '  *":${pathway_plugin_root}:"*) ;;',
    '  *) QT_PLUGIN_PATH="${pathway_plugin_root}${QT_PLUGIN_PATH:+:${QT_PLUGIN_PATH}}" ;;',
    "esac",
    "export QT_PLUGIN_PATH",
    "unset pathway_plugin_root",
    "",
  ].join("\n");
}

/**
 * Writes `contents` to `path` through a staged sibling and a rename, so no
 * reader ever sees a half-written file under the final name. The staged file
 * is removed if anything fails before the rename.
 */
const writeAtomically = (
  path: string,
  contents: string,
  mode?: number,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    const staged = `${path}.${process.pid}.tmp`;
    yield* fs.writeFileString(staged, contents, mode === undefined ? undefined : { mode }).pipe(
      Effect.andThen(fs.rename(staged, path)),
      Effect.tapError(() => fs.remove(staged, { force: true }).pipe(Effect.ignore)),
    );
  });

export type EnvScriptOutcome = "unchanged" | "written";

/**
 * Idempotent: rewrites only when the content differs, so mtime means something.
 *
 * The write is temp-plus-rename, matching install-and-load.sh: Plasma sources
 * every script in this directory at login, and a crash mid-write would leave a
 * truncated one sourced by every future session.
 */
export const ensureEnvScript = (
  path: string,
  contents: string,
): Effect.Effect<EnvScriptOutcome, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* fs
      .readFileString(path)
      .pipe(Effect.orElseSucceed((): string | undefined => undefined));
    if (existing === contents) return "unchanged";
    yield* writeAtomically(path, contents, 0o755);
    return "written";
  });

/**
 * Whether the compositor that is running right now can see the plugin root.
 *
 * The server inherits the session environment, so its own `QT_PLUGIN_PATH` is
 * the same one KWin was started with. That makes this the honest test for "will
 * a load work today, or does this user have to log out first" - far better than
 * assuming the env script took effect the moment it was written.
 */
export function sessionSeesPluginRoot(
  qtPluginRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const entries = (env.QT_PLUGIN_PATH ?? "").split(":").filter(Boolean);
  return entries.includes(qtPluginRoot);
}

export interface PrebuiltBuild {
  /** The exact KWin version this was compiled against. */
  readonly kwinVersion: string;
  readonly arch: string;
  /** Exact distro release used to compile this binary. */
  readonly builtOn: KWinPrebuiltBuiltOn;
  /** Path relative to the prebuilt root. */
  readonly file: string;
  readonly sha256: string;
  /**
   * The toolchain the build was linked against, recorded by the workflow.
   * Absent in manifests written before they were recorded; such a build is
   * only ever selected on its own distribution.
   */
  readonly qtVersion?: string;
  readonly kfVersion?: string;
  readonly glibcVersion?: string;
}

export interface PrebuiltManifest {
  readonly builds: readonly PrebuiltBuild[];
}

/** What selection needs to know about the machine a prebuilt would load on. */
export interface PrebuiltHost {
  /** The matrix entry this host is, exactly, or undefined when it is none of them. */
  readonly builtOn: KWinPrebuiltBuiltOn | undefined;
  /** Matrix entries the host's os-release ID_LIKE points at, in preference order. */
  readonly likeBuiltOn: readonly KWinPrebuiltBuiltOn[];
  readonly qtVersion: string | undefined;
  readonly kfVersion: string | undefined;
}

/** The host as `selectPrebuilt` sees it. Readers are a test seam over the filesystem. */
export function describePrebuiltHost(
  distribution: LinuxDistribution | undefined,
  readers?: HostToolchainReaders,
): PrebuiltHost {
  const toolchain = readHostToolchainVersions(readers);
  return {
    builtOn: prebuiltBuiltOnForDistribution(distribution),
    likeBuiltOn: prebuiltBuiltOnLikeDistribution(distribution),
    qtVersion: toolchain.qtVersion,
    kfVersion: toolchain.kfVersion,
  };
}

/**
 * Exact match on KWin version and architecture, never nearest, and then the
 * build closest to this host.
 *
 * A KWin plugin loads into the version it was built against and no other, and
 * KWin's refusal carries no reason at all - it answers `false` and logs
 * "mismatching plugin version" to its own journal. Shipping a near-miss would
 * turn a clean "no prebuilt for KWin 6.8.1, building from source" into an
 * unexplained failure, so a miss on those two is a miss.
 *
 * Among the exact matches: the build from this host's own distribution release
 * is taken outright, because it was linked against the very packages the host
 * runs. Any other distribution's build is accepted only when its recorded Qt
 * and KDE Frameworks versions both equal the host's, which is the actual
 * condition for the binary to load; a build that recorded no toolchain, or a
 * host whose toolchain cannot be read, never crosses distributions. Between
 * cross-distribution builds that pass, one from a parent named in the host's
 * ID_LIKE is preferred, so a derivative gets its parent's build rather than a
 * coincidental match from elsewhere.
 */
export function selectPrebuilt(
  manifest: PrebuiltManifest,
  kwinVersion: string,
  arch: string,
  host: PrebuiltHost,
): PrebuiltBuild | undefined {
  const candidates = manifest.builds.filter(
    (build) => build.kwinVersion === kwinVersion && build.arch === arch,
  );
  if (host.builtOn) {
    const own = candidates.find((build) => build.builtOn === host.builtOn);
    if (own) return own;
  }
  if (!host.qtVersion || !host.kfVersion) return undefined;
  const compatible = candidates.filter(
    (build) => build.qtVersion === host.qtVersion && build.kfVersion === host.kfVersion,
  );
  for (const like of host.likeBuiltOn) {
    const parent = compatible.find((build) => build.builtOn === like);
    if (parent) return parent;
  }
  return compatible[0];
}

/** The manifest's outer shape; each entry is vetted on its own below. */
const ManifestJson = Schema.fromJsonString(Schema.Struct({ builds: Schema.Array(Schema.Unknown) }));
const decodeManifestJson = Schema.decodeUnknownOption(ManifestJson);

/**
 * Reads a manifest, dropping any entry that could not be acted on anyway.
 *
 * A `file` is a name inside the prebuilt root and nothing else, so a path
 * escape or an empty checksum is a malformed entry rather than something to
 * resolve or install. A missing or unreadable manifest is no prebuilts, never
 * a failure.
 */
export const readPrebuiltManifest = (
  path: string,
): Effect.Effect<PrebuiltManifest | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs
      .readFileString(path)
      .pipe(Effect.orElseSucceed((): string | undefined => undefined));
    if (raw === undefined) return undefined;
    const parsed = decodeManifestJson(raw);
    if (parsed._tag === "None") return undefined;
    const accepted = parsed.value.builds.flatMap((entry) => {
      if (!isPrebuiltBinaryRecord(entry)) return [];
      const { kwinVersion, arch, builtOn, file, sha256, qtVersion, kfVersion, glibcVersion } =
        entry;
      if (!isText(kwinVersion) || !isPrebuiltBuiltOn(builtOn)) return [];
      return [
        {
          kwinVersion,
          arch,
          builtOn,
          file,
          sha256,
          // Optional so manifests from before the toolchain was recorded still
          // read; a build without them simply never crosses distributions.
          ...(isText(qtVersion) ? { qtVersion } : {}),
          ...(isText(kfVersion) ? { kfVersion } : {}),
          ...(isText(glibcVersion) ? { glibcVersion } : {}),
        } satisfies PrebuiltBuild,
      ];
    });
    return accepted.length > 0 ? { builds: accepted } : undefined;
  });

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPrebuiltBuiltOn(value: unknown): value is KWinPrebuiltBuiltOn {
  return (
    value === "fedora-43" ||
    value === "fedora-44" ||
    value === "debian-trixie" ||
    value === "ubuntu-2604" ||
    value === "opensuse-tumbleweed" ||
    value === "arch"
  );
}

/**
 * Re-exported rather than reimplemented: the check is identical for every
 * shipped native binary, and one definition of "is this the binary that was
 * built" is the point. See `provisioning/prebuiltVerification.ts`.
 */
export { readVerifiedPrebuilt, verifyPrebuiltBytes };

/** `PathwayComputerUsePluginV7.so` -> 7, so the next install can outrank it. */
const INSTALLED_PLUGIN_FILE = /^PathwayComputerUsePluginV(\d+)\.so$/;
const PLUGIN_ID_PREFIX = "PathwayComputerUsePluginV";

/** The stamp the installer script also writes; see `writeInstallStamp`. */
export const INSTALL_STAMP_FILE = "install.stamp";
/**
 * The highest plugin number ever handed out on this machine. Shared with
 * scripts/install-and-load.sh (`next_plugin_id`), which reads and advances the
 * same file, and deliberately left alone by uninstall.sh.
 */
export const PLUGIN_ID_COUNTER_FILE = "plugin-id.counter";

export function installStampPath(stateRoot: string): string {
  return join(stateRoot, INSTALL_STAMP_FILE);
}

export function pluginIdCounterPath(stateRoot: string): string {
  return join(stateRoot, PLUGIN_ID_COUNTER_FILE);
}

/** The highest `V<n>` among plugin files, 0 when there is none. */
export function highestInstalledPluginNumber(existingFiles: readonly string[]): number {
  return existingFiles.reduce((max, name) => {
    const match = INSTALLED_PLUGIN_FILE.exec(name);
    return match?.[1] ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

/** The plugin number from `PathwayComputerUsePluginV<n>`, 0 for anything else. */
export function pluginIdNumber(pluginId: string): number {
  const match = /^PathwayComputerUsePluginV(\d+)$/.exec(pluginId);
  return match?.[1] ? Number(match[1]) : 0;
}

/** Directory entries, or none when the directory cannot be read. */
const listDirectory = (
  directory: string,
): Effect.Effect<readonly string[], never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): readonly string[] => []));
  });

/**
 * KWin pins a plugin library once it loads it, for the life of the compositor:
 * loading an id it has already seen serves the still-mapped old library, no
 * matter what file is on disk under that name now. So an id can never be
 * reused within a session, and numbering from the files present is not enough
 * - an uninstall empties the directory, the next install starts again at V1,
 * and the compositor hands back the library that was uninstalled.
 *
 * The counter in the state directory survives the plugin directory, so the
 * next id outranks every id this machine has ever handed out, and every id
 * whose file happens to be on disk. It is written temp-plus-rename so a crash
 * mid-write cannot leave a truncated number that would wind it back.
 */
export const allocatePluginId = (input: {
  readonly stateRoot: string;
  readonly existingFiles: readonly string[];
}): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const counterPath = pluginIdCounterPath(input.stateRoot);
    const raw = yield* fs
      .readFileString(counterPath)
      .pipe(Effect.orElseSucceed((): string | undefined => undefined));
    const counted = raw === undefined ? Number.NaN : Number(raw.trim());
    const next =
      Math.max(
        Number.isSafeInteger(counted) && counted > 0 ? counted : 0,
        highestInstalledPluginNumber(input.existingFiles),
      ) + 1;
    yield* writeAtomically(counterPath, `${next}\n`);
    return `${PLUGIN_ID_PREFIX}${next}`;
  });

/**
 * Writes already-verified bytes as `<pluginDirectory>/<pluginId>.so`.
 *
 * Takes bytes rather than a path so the file that was hashed is the file that
 * lands: a verify-then-copy of the same path checks one read and installs
 * another. The write goes to a `.tmp` sibling, is fsynced, and is renamed into
 * place, so KWin - which rescans this directory on every AvailablePlugins read
 * - can never observe a half-written `.so` under the final name. The id is
 * freshly allocated, so an existing file under it is a bug, not something to
 * overwrite.
 */
export const installPluginBytes = (
  bytes: Uint8Array,
  pluginDirectory: string,
  pluginId: string,
): Effect.Effect<
  string,
  ComputerBackendError | PlatformError.PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(pluginDirectory, { recursive: true });
    const destination = join(pluginDirectory, `${pluginId}.so`);
    if (yield* fs.exists(destination)) {
      return yield* new ComputerBackendError({
        message: `Refusing to overwrite an existing plugin build at ${destination}.`,
      });
    }
    const staged = `${destination}.tmp`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(staged, { flag: "w", mode: 0o755 });
        yield* handle.writeAll(bytes);
        yield* handle.sync;
      }),
    ).pipe(
      Effect.andThen(fs.rename(staged, destination)),
      Effect.tapError(() => fs.remove(staged, { force: true }).pipe(Effect.ignore)),
    );
    return destination;
  });

/**
 * Superseded builds are deleted, not merely left behind.
 *
 * KWin auto-loads any plugin in this directory whose metadata does not opt out,
 * so an old build comes back on the next compositor start and races the current
 * one for the `com.spiritdevs.pathway.ComputerUse` bus name - and the first
 * registrant wins, which shadows the build that was just installed. Unloading
 * the running one is the caller's job; deleting the file is safe either way,
 * because Linux keeps the inode alive for as long as KWin has it mapped.
 *
 * Only builds numbered below `keepPluginId` go. Provisioning never calls this
 * itself: the moment to remove the old build is after the new one has passed
 * its load and health check, and that is the backend's call. And a build
 * numbered above the one that just passed is not superseded by it - it is the
 * install for an upgraded KWin that takes effect at the next login, sitting
 * next to the build the running compositor is still served from.
 */
export const pruneSupersededPlugins = (
  pluginDirectory: string,
  keepPluginId: string,
): Effect.Effect<readonly string[], PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const keep = pluginIdNumber(keepPluginId);
    const removed: string[] = [];
    for (const name of yield* listDirectory(pluginDirectory)) {
      const match = INSTALLED_PLUGIN_FILE.exec(name);
      if (!match?.[1] || Number(match[1]) >= keep) continue;
      yield* fs.remove(join(pluginDirectory, name), { force: true });
      removed.push(name);
    }
    return removed;
  });

/**
 * The record scripts/install-and-load.sh also writes, so a later load refusal
 * can name the KWin version this plugin was built for.
 *
 * The `signature=` line that script uses to skip redundant rebuilds is
 * deliberately absent: it describes a source tree this install may never have
 * compiled, and a missing signature makes the script rebuild rather than trust a
 * stamp it did not write. Temp-plus-rename for the same reason the env script
 * is: a crash mid-write would leave a half-read stamp answering version
 * questions wrongly.
 */
export const writeInstallStamp = (
  path: string,
  record: {
    readonly pluginId: string;
    readonly pluginPath: string;
    readonly kwinVersion: string | undefined;
    readonly linuxDistribution: LinuxDistribution | undefined;
    readonly installedAt: string;
  },
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  writeAtomically(
    path,
    [
      `plugin_id=${record.pluginId}`,
      `installed_at=${record.installedAt}`,
      `plugin_path=${record.pluginPath}`,
      `kwin_version=${record.kwinVersion ?? ""}`,
      `linux_distribution=${linuxDistributionIdentity(record.linuxDistribution) ?? ""}`,
      "",
    ].join("\n"),
  );

export type ProvisionAction = "already-current" | "installed-prebuilt" | "installed-from-source";

/**
 * Where a provisioning run is, for a status read made while it runs (R14):
 * waiting behind another process's install, installing, or compiling — the
 * one stage that takes minutes.
 */
export type ProvisionStage = "waiting-for-lock" | "installing" | "building";

const LOGIN_NEEDED =
  "Log out and back in once to finish enabling it — " +
  "KWin only reads the plugin path when your session starts.";

export interface ProvisionResult {
  readonly action: ProvisionAction;
  /** The id that was installed, absent when nothing was. */
  readonly pluginId?: string;
  /**
   * Where the install lives. The backend prunes superseded builds here with
   * `pruneSupersededPlugins` once the new id has passed its load and health
   * check - never before, and never from inside provisioning.
   */
  readonly pluginDirectory: string;
  /**
   * The install takes effect at the user's next login, so the backend must
   * not try to load it now. True when the running compositor cannot see the
   * plugin directory (the very first install on a machine), and when KWin has
   * been upgraded on disk but the compositor in front of the user is still the
   * old one: the plugin is built for the KWin that will start next time.
   */
  readonly requiresRelogin: boolean;
  /** One sentence for the availability card, in the user's terms. */
  readonly summary: string;
}

/** What the effects a caller hands provisioning may need. */
export type ProvisionServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

export interface ProvisionDependencies {
  readonly target: InstallTarget;
  readonly env?: NodeJS.ProcessEnv;
  /** Files already in the plugin directory, for the version suffix. */
  readonly listInstalled: Effect.Effect<readonly string[], ComputerBackendError, ProvisionServices>;
  /**
   * The KWin installed on disk (its shared library's versioned name), which is what the
   * headers and any prebuilt have to match, or undefined if it cannot be read.
   */
  readonly kwinVersion: Effect.Effect<string | undefined, never, ProvisionServices>;
  /**
   * The KWin the compositor in front of the user is actually running, read
   * from the compositor itself over D-Bus, or undefined when it cannot be
   * asked. Differs from `kwinVersion` between a package upgrade and the next
   * login; see `requiresRelogin`.
   */
  readonly runningKwinVersion: Effect.Effect<string | undefined, never, ProvisionServices>;
  readonly arch: string;
  /** Host os-release identity. Defaults to the cached system detector. */
  readonly linuxDistribution?: () => LinuxDistribution | undefined;
  /** Filesystem reads behind the host's Qt/KF versions. Defaults to the real disk. */
  readonly hostToolchain?: HostToolchainReaders;
  /** Where the shipped binaries live, or undefined when the app ships none. */
  readonly prebuiltRoot?: string | undefined;
  /**
   * Builds the plugin against the local KWin headers and succeeds with the
   * built `.so`. Fails with a message the user can act on when the toolchain or
   * the KWin development headers are missing. It runs under the provisioning
   * lock, so it is interrupted when setup is cancelled and when the lock
   * holder goes away.
   */
  readonly buildFromSource: Effect.Effect<string, ComputerBackendError, ProvisionServices>;
  /**
   * Whether an install for this exact KWin and distro identity is in place.
   * Asked about the on-disk KWin, never the running one: an install for the
   * upgraded KWin is current the moment it is made, even though the running
   * compositor cannot load it until the next login. Judging it against the
   * running version would rebuild it on every reconnect until then.
   */
  readonly isCurrent: (
    kwinVersion: string | undefined,
  ) => Effect.Effect<boolean, never, ProvisionServices>;
  /**
   * Reinstall even when `isCurrent` says nothing needs doing. The backend asks
   * for this after KWin refused the very install the stamp describes as
   * current: the stamp is right that it is in place, and wrong that it works.
   */
  readonly force?: boolean;
  /**
   * The state directory (`STATE_ROOT` in scripts/install-and-load.sh): holds
   * the install stamp a later load refusal reads back and the plugin id
   * counter. See `installStampPath` and `pluginIdCounterPath`.
   */
  readonly stateRoot: string;
  /**
   * Whether the compositor that will load this install can already see the
   * plugin root. Defaults to reading the server's own `QT_PLUGIN_PATH`, which
   * is the honest test for the human's session compositor — the server
   * inherited the same environment KWin started with. A backend that spawns
   * its own compositor with the root injected answers `true` here, because
   * telling its user to log out would be asking them to fix a session the
   * plugin never loads into.
   */
  readonly compositorSeesPluginRoot?: () => boolean;
  /** Told each stage as the run reaches it; see `ProvisionStage`. */
  readonly onStage?: (stage: ProvisionStage) => void;
}

/**
 * Install the plugin if it is not already installed, preferring a shipped
 * binary and falling back to building one.
 *
 * Deliberately does not load it, and does not prune what it supersedes.
 * Loading is the backend's job and it already knows how to unload stale ids
 * first; doing it here would split that logic in two and give the two halves
 * different ideas about which id is newest. Pruning waits on the load: the old
 * build is deleted only once the new one has proven it works, by the backend
 * calling `pruneSupersededPlugins(result.pluginDirectory, result.pluginId)`.
 *
 * Every failure is a `ComputerBackendError` whose message is fit for the
 * availability card; interrupting the run stops a build in progress.
 */
export const provisionKWinPlugin = (
  deps: ProvisionDependencies,
): Effect.Effect<ProvisionResult, ComputerBackendError, ProvisionServices> =>
  withProvisioningFileLock(
    join(deps.target.pluginDirectory, ".pathway-provision.lock"),
    Effect.suspend(() => {
      deps.onStage?.("installing");
      return provisionKWinPluginLocked(deps);
    }),
    { onLockRequested: Effect.sync(() => deps.onStage?.("waiting-for-lock")) },
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(
          new ComputerBackendError({
            message: `Installing the computer-use plugin failed: ${cause.message}`,
            cause,
          }),
        ),
      ProvisioningLockError: (cause) =>
        Effect.fail(new ComputerBackendError({ message: cause.message, retryable: true, cause })),
    }),
  );

const provisionKWinPluginLocked = (deps: ProvisionDependencies) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const env = deps.env ?? process.env;
    // Written before anything else, and on every run. It is the piece that makes
    // the install visible to KWin at all, and it is cheap and idempotent, so there
    // is no case where skipping it is worth the risk of it having been deleted.
    yield* ensureEnvScript(envScriptPath(env), renderEnvScript(deps.target.qtPluginRoot));
    const visible =
      deps.compositorSeesPluginRoot?.() ?? sessionSeesPluginRoot(deps.target.qtPluginRoot, env);

    const [version, running] = yield* Effect.all([deps.kwinVersion, deps.runningKwinVersion], {
      concurrency: "unbounded",
    });
    // A KWin upgrade on disk that the running session has not picked up yet.
    // Everything that follows targets the on-disk version, because that is what
    // the headers and the prebuilts match and what the next session will run;
    // the running compositor simply cannot load it until then.
    const upgradePending = version !== undefined && running !== undefined && version !== running;
    const pluginDirectory = deps.target.pluginDirectory;

    if (!deps.force && (yield* deps.isCurrent(version))) {
      // Current is not the same as loadable: until the session has been
      // restarted once, an install the compositor cannot see stays invisible no
      // matter how current it is, and the remedy is the same login as on the
      // day it was installed.
      return {
        action: "already-current",
        pluginDirectory,
        requiresRelogin: !visible || upgradePending,
        summary: upgradePending
          ? `The computer-use plugin is installed for KWin ${version}, which takes effect at your next login.`
          : visible
            ? "The computer-use plugin is installed and current."
            : `The computer-use plugin is installed and current. ${LOGIN_NEEDED}`,
      } satisfies ProvisionResult;
    }

    const distribution = deps.linuxDistribution
      ? deps.linuxDistribution()
      : detectLinuxDistribution();
    const manifest = deps.prebuiltRoot
      ? yield* readPrebuiltManifest(join(deps.prebuiltRoot, "manifest.json"))
      : undefined;
    const prebuilt =
      manifest && version
        ? selectPrebuilt(
            manifest,
            version,
            deps.arch,
            describePrebuiltHost(distribution, deps.hostToolchain),
          )
        : undefined;

    let bytes: Uint8Array;
    let action: ProvisionAction;
    if (prebuilt && deps.prebuiltRoot) {
      const verified = yield* readVerifiedPrebuilt(
        join(deps.prebuiltRoot, prebuilt.file),
        prebuilt.sha256,
      );
      if (!verified) {
        return yield* new ComputerBackendError({
          message:
            `The bundled computer-use plugin for KWin ${prebuilt.kwinVersion} failed its checksum, ` +
            "so it was not installed. Reinstalling Pathway replaces it.",
        });
      }
      bytes = verified;
      action = "installed-prebuilt";
    } else {
      deps.onStage?.("building");
      bytes = yield* fs.readFile(yield* deps.buildFromSource);
      action = "installed-from-source";
    }

    const pluginId = yield* allocatePluginId({
      stateRoot: deps.stateRoot,
      existingFiles: [...(yield* deps.listInstalled), ...(yield* listDirectory(pluginDirectory))],
    });
    const pluginPath = yield* installPluginBytes(bytes, pluginDirectory, pluginId);
    // Older builds stay on disk here on purpose. Until the new id has been
    // loaded and answered its health check, the old file is the build the user
    // is running, and the one that has to survive if the new one is refused.
    const installedAt = DateTime.formatIso(yield* DateTime.now);
    yield* writeInstallStamp(installStampPath(deps.stateRoot), {
      pluginId,
      pluginPath,
      kwinVersion: version,
      linuxDistribution: distribution,
      installedAt,
    });

    return {
      action,
      pluginId,
      pluginDirectory,
      requiresRelogin: !visible || upgradePending,
      summary: upgradePending
        ? `The computer-use plugin was installed for the upgraded KWin ${version}. It takes effect at your next login; until then the current session keeps the build it is running.`
        : visible
          ? "The computer-use plugin is installed and ready."
          : `The computer-use plugin is installed. ${LOGIN_NEEDED}`,
    } satisfies ProvisionResult;
  });
