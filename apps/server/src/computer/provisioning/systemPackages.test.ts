// @effect-diagnostics nodeBuiltinImport:off - a fake pkexec is an EventEmitter with passthrough streams.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { ComputerBackendError } from "../computerErrors.ts";
import {
  awaitingAuthorization,
  commandOnPath,
  createPkexecRunner,
  installSystemPackages,
  installClipboardSystemPackage,
  planSystemPackageInstall,
  PrivilegedRunFailure,
  type PrivilegedRunner,
  type SystemPackagePlan,
} from "./systemPackages.ts";

const exitFailure = (code: number | string, stderr = "") =>
  Effect.fail(new PrivilegedRunFailure({ code, stdout: "", stderr }));

/** A runner that records its calls and succeeds. */
function recordingRunner() {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const run: PrivilegedRunner = (command, args) =>
    Effect.sync(() => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    });
  return { calls, run };
}

const EVERY_MANAGER = () => true;

describe("planSystemPackageInstall", () => {
  it("packages for the distribution's own manager, not the first one on PATH", () => {
    // The failure this replaces: a Debian container's dnf, or a pacman
    // installed on Ubuntu to build an AUR package, decided which manager ran
    // as root. That is not a failed install — it is a package database being
    // written by a manager that does not own it.
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "debian" })?.manager).toBe("apt-get");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "fedora" })?.manager).toBe("dnf");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "arch" })?.manager).toBe("pacman");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "opensuse-tumbleweed" })?.manager).toBe(
      "zypper",
    );
  });

  it("knows the derivatives by name rather than guessing from a family", () => {
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "linuxmint" })?.manager).toBe("apt-get");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "Manjaro" })?.manager).toBe("pacman");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "rocky" })?.manager).toBe("dnf");
  });

  it("falls back to PATH order for a distribution nobody here has heard of", () => {
    expect(
      planSystemPackageInstall((command) => command === "dnf", { id: "gentoo" })?.manager,
    ).toBe("dnf");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "unknown" })?.manager).toBe("pacman");
  });

  it("falls back to PATH when a derivative swapped the manager out from under it", () => {
    // Named as apt-get, but this machine has no apt-get: an identity that
    // cannot run is worse than no identity at all.
    expect(
      planSystemPackageInstall((command) => command === "dnf", { id: "ubuntu" })?.manager,
    ).toBe("dnf");
  });

  it("names the packages for the manager it picked", () => {
    const plan = planSystemPackageInstall(EVERY_MANAGER, { id: "fedora" });
    expect(plan?.packages).toContain("kwin-wayland");
    expect(plan?.packages).toContain("kwin-devel");
  });

  it("answers undefined when no manager it knows is installed at all", () => {
    expect(planSystemPackageInstall(() => false, { id: "arch" })).toBeUndefined();
    expect(planSystemPackageInstall(() => false)).toBeUndefined();
  });

  it("names the compositor and the build toolchain in every plan", () => {
    for (const manager of ["pacman", "apt-get", "dnf", "zypper"]) {
      const plan = planSystemPackageInstall((command) => command === manager);
      expect(plan, manager).toBeDefined();
      expect(plan!.packages.join(" "), manager).toMatch(/kwin/);
      expect(plan!.packages, manager).toContain("cmake");
      expect(plan!.packages, manager).toContain("wl-clipboard");
      expect(plan!.packages, manager).toContain("extra-cmake-modules");
      expect(plan!.packages, manager).toContain("make");
      // The build script configures CMake with `-G Ninja` and refuses to start
      // without it; the package is named differently across distributions.
      expect(
        plan!.packages.filter((name) => /^ninja(-build)?$/.test(name)),
        manager,
      ).toHaveLength(1);
    }
  });
});

describe("installSystemPackages", () => {
  const plan: SystemPackagePlan = {
    manager: "pacman",
    args: ["-S", "--needed", "--noconfirm"],
    packages: ["kwin", "cmake"],
  };

  it.effect("runs the manager non-interactively with the whole package set", () =>
    Effect.gen(function* () {
      const { calls, run } = recordingRunner();
      const summary = yield* installSystemPackages(plan, run);
      expect(calls).toEqual([
        { command: "pacman", args: ["-S", "--needed", "--noconfirm", "kwin", "cmake"] },
      ]);
      expect(summary).toBe("Installed kwin, cmake with pacman.");
    }),
  );

  it.effect("keeps apt from stopping on a debconf question", () =>
    Effect.gen(function* () {
      const aptPlan: SystemPackagePlan = {
        manager: "apt-get",
        args: ["install", "-y"],
        packages: ["kwin-wayland"],
      };
      const { calls, run } = recordingRunner();
      yield* installSystemPackages(aptPlan, run);
      expect(calls[0]?.command).toBe("env");
      expect(calls[0]?.args).toEqual([
        "DEBIAN_FRONTEND=noninteractive",
        "apt-get",
        "install",
        "-y",
        "kwin-wayland",
      ]);
    }),
  );

  it.effect("translates a dismissed authorization dialog into a retryable refusal", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(installSystemPackages(plan, () => exitFailure(126)));
      expect(error.retryable).toBe(true);
      expect(error.message).toContain("authorization dialog was dismissed");
    }),
  );

  it.effect("explains a missing polkit agent and offers the manual command", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(installSystemPackages(plan, () => exitFailure(127)));
      expect(error.message).toMatch(
        /authorization failed.*sudo pacman -S --needed --noconfirm kwin cmake/s,
      );
    }),
  );

  it.effect("explains missing pkexec and offers the manual command", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(installSystemPackages(plan, () => exitFailure("ENOENT")));
      expect(error.message).toMatch(/pkexec is not installed.*sudo pacman/s);
    }),
  );

  it.effect("surfaces the package manager's own last words on other failures", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        installSystemPackages(plan, () =>
          exitFailure(1, "resolving dependencies...\nerror: target not found: kwin\n"),
        ),
      );
      expect(error.message).toBe(
        "pacman failed to install packages: error: target not found: kwin",
      );
    }),
  );

  it.effect("passes a refusal the runner already worded through unchanged", () =>
    Effect.gen(function* () {
      const refusal = new ComputerBackendError({ message: "worded already", retryable: true });
      const error = yield* Effect.flip(installSystemPackages(plan, () => Effect.fail(refusal)));
      expect(error).toBe(refusal);
    }),
  );
});

describe("commandOnPath", () => {
  it("resolves through PATH entries the way the shell would", () => {
    const seen: string[] = [];
    const found = commandOnPath("kwin_wayland", { PATH: "/usr/local/bin:/usr/bin" }, (path) => {
      seen.push(path);
      return path === "/usr/bin/kwin_wayland";
    });
    expect(found).toBe(true);
    expect(seen).toEqual(["/usr/local/bin/kwin_wayland", "/usr/bin/kwin_wayland"]);
  });

  it("answers no with no PATH at all", () => {
    expect(commandOnPath("kwin_wayland", {}, () => true)).toBe(false);
  });
});

describe("installClipboardSystemPackage", () => {
  it.effect("installs only clipboard utilities on an existing host desktop", () =>
    Effect.gen(function* () {
      const { calls, run } = recordingRunner();
      yield* installClipboardSystemPackage(
        () => planSystemPackageInstall((command) => command === "apt-get"),
        run,
      );
      expect(calls).toEqual([
        {
          command: "env",
          args: ["DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "wl-clipboard"],
        },
      ]);
    }),
  );

  it.effect("offers manual setup when no package manager is recognized", () =>
    Effect.gen(function* () {
      const { calls, run } = recordingRunner();
      const error = yield* Effect.flip(installClipboardSystemPackage(() => undefined, run));
      expect(error.message).toContain(
        "Install wl-clipboard with your distribution's package manager",
      );
      expect(calls).toEqual([]);
    }),
  );
});

/** A pkexec that records signals and ends only when told to. */
class FakePkexec extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4_242_424;
  exitCode: number | null = null;

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("close", code, signal);
  }
}

function pkexecHarness(options: { readonly timeoutMs?: number } = {}) {
  const child = new FakePkexec();
  const state = {
    awaiting: true,
    signals: [] as string[],
    argv: [] as string[],
    /** Called on every authorization check the runner makes. */
    onCheck: () => {},
  };
  const run = createPkexecRunner({
    spawnPkexec: (args) => {
      state.argv = [...args];
      return child as unknown as ChildProcess;
    },
    awaitingAuthorization: () => {
      state.onCheck();
      return state.awaiting;
    },
    signalProcess: (_pid, signal) => {
      if (!state.awaiting) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      state.signals.push(signal);
      queueMicrotask(() => child.finish(null, signal));
    },
    authorizationTimeoutMs: options.timeoutMs ?? 60_000,
  });
  return { child, state, run };
}

describe("the pkexec runner", () => {
  const plan: SystemPackagePlan = { manager: "pacman", args: ["-S"], packages: ["kwin"] };

  it.effect("gives up on a dialog nobody answers, which installs nothing", () =>
    Effect.gen(function* () {
      const { state, run } = pkexecHarness({ timeoutMs: 300_000 });
      const install = yield* Effect.forkChild(Effect.flip(installSystemPackages(plan, run)), {
        startImmediately: true,
      });
      yield* TestClock.adjust(300_000);
      const error = yield* Fiber.join(install);
      expect(state.signals).toEqual(["SIGTERM"]);
      expect(error.message).toContain(
        "Nobody answered the system authorization dialog within 5 minutes",
      );
      expect(error.retryable).toBe(true);
    }),
  );

  it.effect("never interrupts a package manager that is already running as root", () =>
    Effect.gen(function* () {
      const { child, state, run } = pkexecHarness({ timeoutMs: 1_000 });
      const install = yield* Effect.forkChild(run("pacman", ["-S", "kwin"]), {
        startImmediately: true,
      });
      // Authorized: pkexec has become the manager.
      state.awaiting = false;
      yield* TestClock.adjust(10 * 60_000);

      const checked = Deferred.makeUnsafe<void>();
      state.onCheck = () => Deferred.doneUnsafe(checked, Exit.void);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(install), {
        startImmediately: true,
      });
      yield* Deferred.await(checked);
      expect(state.signals).toEqual([]);
      // A slow mirror is allowed to be slow; the interruption lands only when
      // the manager ends.
      expect(interrupting.pollUnsafe()).toBeUndefined();

      child.finish(0);
      yield* Fiber.join(interrupting);
      expect(Exit.hasInterrupts(yield* Fiber.await(install))).toBe(true);
      expect(state.signals).toEqual([]);
    }),
  );

  it.effect("cancels a run that is still waiting for authorization", () =>
    Effect.gen(function* () {
      const { state, run } = pkexecHarness();
      const install = yield* Effect.forkChild(installSystemPackages(plan, run), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(install);
      expect(Exit.hasInterrupts(yield* Fiber.await(install))).toBe(true);
      expect(state.signals).toEqual(["SIGTERM"]);
      expect(state.argv).toEqual(["pacman", "-S", "kwin"]);
    }),
  );

  it.effect("does not start a run that was interrupted before it began", () =>
    Effect.gen(function* () {
      const { state, run } = pkexecHarness();
      const install = yield* Effect.forkChild(run("pacman", ["-S"]));
      yield* Fiber.interrupt(install);
      expect(Exit.hasInterrupts(yield* Fiber.await(install))).toBe(true);
      expect(state.argv).toEqual([]);
    }),
  );

  it("never takes an ordinary process for pkexec awaiting a dialog", () => {
    expect(awaitingAuthorization(process.pid)).toBe(false);
    expect(awaitingAuthorization(2 ** 30)).toBe(false);
  });

  it.effect("still reports the manager's own exit codes", () =>
    Effect.gen(function* () {
      const { child, run } = pkexecHarness();
      const install = yield* Effect.forkChild(Effect.flip(installSystemPackages(plan, run)), {
        startImmediately: true,
      });
      child.finish(126);
      const error = yield* Fiber.join(install);
      expect(error.message).toMatch(/authorization dialog was dismissed/);
    }),
  );
});
