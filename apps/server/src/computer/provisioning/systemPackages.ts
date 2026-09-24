// @effect-diagnostics nodeBuiltinImport:off - pkexec is spawned and signalled by pid, and /proc and PATH are read synchronously.
/**
 * The one privileged step of computer-use setup: installing distribution
 * packages through polkit.
 *
 * Everything else Pathway provisions lands in the user's home directory and can
 * happen silently, but `kwin_wayland` and the toolchain that compiles the KWin
 * plugin come from the distribution. Installing them is a root operation, so it
 * runs through `pkexec` — the desktop's own authorization dialog — and only
 * from the explicit "Set up" request in the settings panel, never from a probe
 * or an availability read. One invocation covers the whole package set, so the
 * user authorizes at most once per setup.
 *
 * The sets name both the compositor and the build dependencies on purpose: a
 * machine that needs `kwin_wayland` installed has, with near certainty, never
 * compiled the plugin either, and every listed manager skips packages that are
 * already present, so over-asking costs nothing but covers the second failure
 * in the same authorization.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants, accessSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { ComputerBackendError } from "../computerErrors.ts";
import { detectLinuxDistribution, type LinuxDistribution } from "./linuxDistribution.ts";

/** Enough of the manager's own transcript to quote a failure, never the whole log. */
const MAX_INSTALL_OUTPUT_BYTES = 16 * 1024;
const PKEXEC_DISMISSED_EXIT = 126;
const PKEXEC_AUTHORIZATION_ERROR_EXIT = 127;
/**
 * How long an authorization dialog may sit unanswered. Only the wait for the
 * dialog has a deadline; once the manager runs, nothing here interrupts it.
 */
const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;

export interface SystemPackagePlan {
  /** The package manager binary, which is also how the distribution is named to the user. */
  readonly manager: string;
  /** Arguments after the manager, non-interactive and idempotent for every manager. */
  readonly args: readonly string[];
  readonly packages: readonly string[];
}

/**
 * Per-manager package sets. `kwin` is the nested compositor itself; the rest
 * is what `install-and-load.sh` needs to compile the plugin against the local
 * KWin headers: cmake, ECM, a C++ compiler, and ninja, which the script
 * configures CMake with (`-G Ninja`) and checks for before it starts.
 */
const PLANS: readonly SystemPackagePlan[] = [
  {
    manager: "pacman",
    args: ["-S", "--needed", "--noconfirm"],
    packages: ["kwin", "wl-clipboard", "cmake", "extra-cmake-modules", "gcc", "make", "ninja"],
  },
  {
    manager: "apt-get",
    args: ["install", "-y"],
    packages: [
      "kwin-wayland",
      "wl-clipboard",
      "kwin-dev",
      "cmake",
      "extra-cmake-modules",
      "g++",
      "make",
      "ninja-build",
    ],
  },
  {
    manager: "dnf",
    args: ["install", "-y"],
    packages: [
      "kwin-wayland",
      "wl-clipboard",
      "kwin-devel",
      "cmake",
      "extra-cmake-modules",
      "gcc-c++",
      "make",
      "ninja-build",
    ],
  },
  {
    manager: "zypper",
    args: ["--non-interactive", "install"],
    packages: [
      "kwin6",
      "kwin6-devel",
      "wl-clipboard",
      "cmake",
      "extra-cmake-modules",
      "gcc-c++",
      "make",
      "ninja",
    ],
  },
];

/** Whether `command` resolves on PATH, the way the shell would resolve it. */
export function commandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  executable: (path: string) => boolean = isExecutableFile,
): boolean {
  const path = env.PATH;
  if (!path) return false;
  return path.split(delimiter).some((dir) => dir !== "" && executable(join(dir, command)));
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which package manager each distribution's packages are named for.
 *
 * Identity, not PATH order, because PATH order gets this wrong in exactly the
 * cases that hurt most: a Debian container's `dnf`, a `pacman` installed on
 * Ubuntu to build an AUR package in a chroot, a workstation with Homebrew-style
 * side installs. Running the wrong manager as root is not a failed install —
 * it is a package database being written by a manager that does not own it.
 *
 * Derivatives are listed by name rather than resolved through `ID_LIKE`: a
 * derivative that renames `kwin-wayland` would be silently mispackaged by a
 * `like` rule, and one listed here has been looked at.
 */
const MANAGER_BY_DISTRIBUTION: Readonly<Record<string, string>> = {
  arch: "pacman",
  cachyos: "pacman",
  endeavouros: "pacman",
  garuda: "pacman",
  manjaro: "pacman",
  debian: "apt-get",
  elementary: "apt-get",
  kali: "apt-get",
  linuxmint: "apt-get",
  neon: "apt-get",
  pop: "apt-get",
  raspbian: "apt-get",
  ubuntu: "apt-get",
  zorin: "apt-get",
  almalinux: "dnf",
  centos: "dnf",
  fedora: "dnf",
  nobara: "dnf",
  rhel: "dnf",
  rocky: "dnf",
  opensuse: "zypper",
  "opensuse-leap": "zypper",
  "opensuse-tumbleweed": "zypper",
  sles: "zypper",
};

/**
 * The plan for this machine, or `undefined` when no manager any plan knows is
 * installed at all.
 *
 * The distribution's own identity decides first, and only a distribution this
 * module has never heard of — or one whose named manager is genuinely missing,
 * which is what a derivative that swapped managers looks like — falls back to
 * PATH order.
 */
export function planSystemPackageInstall(
  hasCommand: (command: string) => boolean = (command) => commandOnPath(command),
  distribution: LinuxDistribution | undefined = detectLinuxDistribution(),
): SystemPackagePlan | undefined {
  const named = distribution ? MANAGER_BY_DISTRIBUTION[distribution.id.toLowerCase()] : undefined;
  const byIdentity = named ? PLANS.find((plan) => plan.manager === named) : undefined;
  if (byIdentity && hasCommand(byIdentity.manager)) return byIdentity;
  return PLANS.find((plan) => hasCommand(plan.manager));
}

/** Explicit setup for a host compositor needs clipboard tools, not another compositor. */
export const installClipboardSystemPackage = (
  planPackages: () => SystemPackagePlan | undefined = planSystemPackageInstall,
  run: PrivilegedRunner = pkexecRunner,
): Effect.Effect<string, ComputerBackendError> =>
  Effect.suspend(() => {
    const plan = planPackages();
    if (!plan) {
      return Effect.fail(
        new ComputerBackendError({
          message:
            "Install wl-clipboard with your distribution's package manager, then run Set up again.",
        }),
      );
    }
    return installSystemPackages({ ...plan, packages: ["wl-clipboard"] }, run);
  });

export interface PrivilegedRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs one privileged command. Interrupting it cancels the run only while it
 * is still waiting for authorization; once the package manager runs as root,
 * the interruption waits for it to finish.
 */
export type PrivilegedRunner = (
  command: string,
  args: readonly string[],
) => Effect.Effect<PrivilegedRunResult, PrivilegedRunFailure | ComputerBackendError>;

/** A pkexec exit that carries the manager's own words. */
export class PrivilegedRunFailure extends Schema.TaggedErrorClass<PrivilegedRunFailure>()(
  "PrivilegedRunFailure",
  {
    /** The exit code, the ending signal, or the spawn error's code. */
    code: Schema.Union([Schema.Number, Schema.String]),
    stdout: Schema.String,
    stderr: Schema.String,
  },
) {
  override get message(): string {
    return `pkexec exited with ${this.code}`;
  }
}

export interface PkexecRunnerDependencies {
  readonly spawnPkexec?: (args: readonly string[]) => ChildProcess;
  /** Whether a pid is still pkexec waiting for its dialog; see `awaitingAuthorization`. */
  readonly awaitingAuthorization?: (pid: number) => boolean;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly authorizationTimeoutMs?: number;
}

/**
 * Whether `pid` is still pkexec waiting for the authorization dialog rather
 * than the package manager it becomes.
 *
 * pkexec is setuid root but keeps the caller's *real* uid until the dialog is
 * answered; only then does it take root's real uid as well and exec the
 * manager in the same pid. So a real uid that is still this user's means no
 * package manager has started, and ending the process installs nothing. After
 * that switch the kernel refuses this user's signals anyway, which makes the
 * race between this check and the signal harmless: the signal either reaches a
 * pkexec that has not exec'd, or fails.
 */
export function awaitingAuthorization(pid: number): boolean {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const name = /^Name:\s*(\S+)/m.exec(status)?.[1];
    const realUid = /^Uid:\s*(\d+)/m.exec(status)?.[1];
    return name === "pkexec" && realUid !== undefined && Number(realUid) === process.getuid?.();
  } catch {
    return false;
  }
}

/**
 * Runs one privileged command, streaming its output instead of buffering it.
 *
 * Neither a timeout on the whole run nor an output limit belongs here. Both
 * kill `pkexec`, and after authorization `pkexec` *is* the package manager,
 * running as root with its transaction half applied and its lock file held.
 * The user is then left with a dpkg that demands `--configure -a`, or a pacman
 * whose db.lck no unprivileged process can remove, and Pathway's own message
 * says the install timed out. There is no deadline on the manager that is
 * better than letting a slow mirror be slow.
 *
 * The wait for the dialog is different: nothing has run yet, so ending it
 * costs nothing, and a dialog nobody answers — the user walked away, or no
 * polkit agent ever showed one — must not wedge Set up forever. That wait has
 * a deadline and honours interruption; the manager has neither.
 *
 * pkexec is spawned directly rather than through the Effect process spawner:
 * the spawner's scope kills its child's process group on the way out, and
 * that child may be a package manager running as root.
 *
 * Output is streamed and only its tail is kept, so a manager that prints a
 * hundred megabytes of progress cannot grow this process's heap either.
 */
export function createPkexecRunner(dependencies: PkexecRunnerDependencies = {}): PrivilegedRunner {
  const spawnPkexec =
    dependencies.spawnPkexec ??
    ((args: readonly string[]) =>
      spawn("pkexec", [...args], { stdio: ["ignore", "pipe", "pipe"] }));
  const stillAwaiting = dependencies.awaitingAuthorization ?? awaitingAuthorization;
  const signalProcess =
    dependencies.signalProcess ??
    ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const timeoutMs = dependencies.authorizationTimeoutMs ?? AUTHORIZATION_TIMEOUT_MS;
  return (command, args) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // pkexec strips the environment anyway; DEBIAN_FRONTEND rides the argv
        // through `env` when apt is the manager.
        const child = spawnPkexec([command, ...args]);
        const stdout = outputTail();
        const stderr = outputTail();
        const closed = Deferred.makeUnsafe<
          PrivilegedRunResult,
          PrivilegedRunFailure | ComputerBackendError
        >();
        let cancelled: ComputerBackendError | undefined;
        /** Ends pkexec only if it is still waiting for its dialog. */
        const cancelWhileUnauthorized = (reason: ComputerBackendError) => {
          const pid = child.pid;
          if (cancelled || pid === undefined || child.exitCode !== null) return;
          if (!stillAwaiting(pid)) return;
          try {
            signalProcess(pid, "SIGTERM");
            cancelled = reason;
          } catch {
            // Already the package manager, now root's: it runs to completion.
          }
        };
        child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", (error: NodeJS.ErrnoException) => {
          Deferred.doneUnsafe(
            closed,
            Exit.fail(
              new PrivilegedRunFailure({
                code: error.code ?? "spawn-failed",
                stdout: stdout.text(),
                stderr: stderr.text(),
              }),
            ),
          );
        });
        child.once("close", (code, exitSignal) => {
          if (cancelled) {
            Deferred.doneUnsafe(closed, Exit.fail(cancelled));
          } else if (code === 0) {
            Deferred.doneUnsafe(
              closed,
              Exit.succeed({ stdout: stdout.text(), stderr: stderr.text() }),
            );
          } else {
            Deferred.doneUnsafe(
              closed,
              Exit.fail(
                new PrivilegedRunFailure({
                  code: code ?? exitSignal ?? "unknown",
                  stdout: stdout.text(),
                  stderr: stderr.text(),
                }),
              ),
            );
          }
        });
        const authorizationDeadline = yield* Effect.forkChild(
          Effect.sleep(Duration.millis(timeoutMs)).pipe(
            Effect.andThen(
              Effect.sync(() => cancelWhileUnauthorized(authorizationTimeoutError(timeoutMs))),
            ),
          ),
          { startImmediately: true },
        );
        // Interrupted: a dialog still waiting is ended, and either way the
        // interruption lands only once pkexec, or the manager it became, exits.
        return yield* restore(Deferred.await(closed)).pipe(
          Effect.onInterrupt(() =>
            Effect.suspend(() => {
              cancelWhileUnauthorized(authorizationCancelledError());
              return Effect.exit(Deferred.await(closed));
            }),
          ),
          Effect.ensuring(Fiber.interrupt(authorizationDeadline)),
        );
      }),
    );
}

const pkexecRunner: PrivilegedRunner = createPkexecRunner();

function authorizationTimeoutError(timeoutMs: number): ComputerBackendError {
  const minutes = Math.round(timeoutMs / 60_000);
  return new ComputerBackendError({
    message:
      `Nobody answered the system authorization dialog within ${minutes} minute${minutes === 1 ? "" : "s"}, ` +
      "so no packages were installed. Click Set up again to retry.",
    retryable: true,
  });
}

function authorizationCancelledError(): ComputerBackendError {
  return new ComputerBackendError({
    message:
      "Package installation was cancelled before it was authorized, so no packages were installed.",
    retryable: true,
  });
}

/** The tail of one stream: enough to quote a failure, bounded against a flood. */
function outputTail() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    push: (chunk: Buffer) => {
      chunks.push(chunk);
      bytes += chunk.byteLength;
      while (bytes > MAX_INSTALL_OUTPUT_BYTES && chunks.length > 1) {
        bytes -= chunks.shift()?.byteLength ?? 0;
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * Installs the plan's packages through one polkit authorization, and returns
 * the sentence the settings card shows for this step.
 *
 * The two pkexec-specific exit codes are translated because they are the two
 * outcomes the user caused or can fix: 126 is the authorization dialog being
 * dismissed, 127 is an authorization or other pkexec error. Everything else is the
 * package manager failing, and its own words are the most actionable message
 * available.
 */
export const installSystemPackages = (
  plan: SystemPackagePlan,
  run: PrivilegedRunner = pkexecRunner,
): Effect.Effect<string, ComputerBackendError> => {
  const commandLine = [plan.manager, ...plan.args, ...plan.packages];
  // apt-get is the one manager here that can still stop to ask a debconf
  // question with `-y` alone.
  const argv =
    plan.manager === "apt-get"
      ? ["env", "DEBIAN_FRONTEND=noninteractive", ...commandLine]
      : commandLine;
  return run(argv[0]!, argv.slice(1)).pipe(
    // A refusal this module already worded — an unanswered dialog, a cancel —
    // passes through as it is.
    Effect.catchTag("PrivilegedRunFailure", (failure) =>
      Effect.fail(describeInstallFailure(plan, failure)),
    ),
    Effect.as(`Installed ${plan.packages.join(", ")} with ${plan.manager}.`),
  );
};

function describeInstallFailure(
  plan: SystemPackagePlan,
  failure: PrivilegedRunFailure,
): ComputerBackendError {
  const manual = `sudo ${plan.manager} ${[...plan.args, ...plan.packages].join(" ")}`;
  if (failure.code === "ENOENT") {
    return new ComputerBackendError({
      message:
        "pkexec is not installed, so Pathway cannot ask for authorization to install packages. " +
        `Install them yourself: ${manual}`,
      cause: failure,
    });
  }
  if (failure.code === PKEXEC_DISMISSED_EXIT) {
    return new ComputerBackendError({
      message:
        "The system authorization dialog was dismissed, so no packages were installed. " +
        "Click Set up again to retry.",
      retryable: true,
      cause: failure,
    });
  }
  if (failure.code === PKEXEC_AUTHORIZATION_ERROR_EXIT) {
    return new ComputerBackendError({
      message:
        "System authorization failed or could not be obtained. Click Set up to retry, or " +
        `install the packages yourself: ${manual}`,
      retryable: true,
      cause: failure,
    });
  }
  const detail = failure.stderr.trim() ? failure.stderr.trim().split("\n").at(-1) : failure.message;
  return new ComputerBackendError({
    message: `${plan.manager} failed to install packages: ${detail}`,
    cause: failure,
  });
}
