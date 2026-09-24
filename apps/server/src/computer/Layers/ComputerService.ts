// @effect-diagnostics nodeBuiltinImport:off - an inherited descriptor is read by number; Effect's FileSystem opens paths only.
/**
 * Builds the ComputerService: picks the backend for this host, runs the passive
 * boot probe, and owns the manager for the layer's lifetime. On Linux the pick
 * runs off the startup path; see `startLinuxBackend`.
 *
 * Requires `ComputerApprovalGate`, so Off/Stop withdraws approval cards and a
 * desktop interruption revokes standing grants.
 *
 * @module computer/Layers/ComputerService
 */
import * as NodeFS from "node:fs";

import type { ComputerAvailability } from "@spiritdevs/contracts";
import { CUA_HOST_SOCKET_ENV } from "@spiritdevs/shared/cuaDriverProtocol";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import { ServerConfig } from "../../config.ts";
import type { ComputerBackend } from "../ComputerBackend.ts";
import { ComputerApprovalGate } from "../ComputerApprovalGate.ts";
import { ComputerManager } from "../ComputerManager.ts";
import { makeCuaComputerBackend } from "../CuaComputerBackend.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import {
  isLinuxBackendChoice,
  parseComputerBackendOverride,
  selectLinuxBackend,
  type LinuxBackendChoice,
} from "../linuxBackendSelection.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import {
  CheckingComputerBackend,
  makeSwitchableComputerBackend,
  type ComputerBackendSwapOptions,
} from "../switchableComputerBackend.ts";
import {
  makeUnavailableComputerBackend,
  UnavailableComputerBackend,
} from "../UnavailableComputerBackend.ts";

export const COMPUTER_BACKEND_ENV = "PATHWAY_COMPUTER_BACKEND";
export const COMPUTER_HOST_CAPABILITY_ENV = "PATHWAY_BROWSER_HOST_CAPABILITY";
export const COMPUTER_HOST_CAPABILITY_FD_ENV = "PATHWAY_BROWSER_HOST_CAPABILITY_FD";

export interface ComputerServiceLiveOptions {
  /** Inject a real or fake backend. */
  readonly backend?: ComputerBackend;
  /** Test/embedding override for the final availability decision. */
  readonly supported?: boolean;
  /** Test override for `COMPUTER_SELECTION_STARTUP_BUDGET_MS`. */
  readonly selectionBudgetMs?: number;
  /** Test override for how a selected Linux tier is constructed. */
  readonly linuxBackends?: Partial<Record<LinuxBackendChoice, LinuxBackendFactory>>;
}

/**
 * Builds one Linux tier's backend. It runs in a scope of its own, closed when
 * the backend leaves the slot, so a replaced desktop releases what it held.
 */
export type LinuxBackendFactory = Effect.Effect<ComputerBackend, never, Scope.Scope>;

/**
 * The constructor behind each Linux choice. Keyed by the choice so a backend
 * that registers a tier in `linuxBackendSelection.ts` cannot forget to say how
 * it is built; the type fails the build otherwise.
 */
const LINUX_BACKENDS: Record<LinuxBackendChoice, LinuxBackendFactory> = {};

/**
 * How long startup waits for Linux backend selection, and then for its passive
 * probe, before carrying on without the answer. A healthy host answers both in
 * milliseconds, so this only ever matters on a wedged session bus, where each
 * question would otherwise hold boot for its full D-Bus timeout.
 */
export const COMPUTER_SELECTION_STARTUP_BUDGET_MS = 1_500;

const CHECKING_MESSAGE = "Pathway is still detecting this computer's desktop.";

const MIN_CAPABILITY_BYTES = 32;

/**
 * The host socket's shared secret: given directly, or inherited on a file
 * descriptor the desktop app opened for this server. Anything shorter than
 * the minimum is ignored rather than trusted. Both variables are consumed and
 * the descriptor closed, so provider CLIs spawned later inherit neither.
 */
export const resolveHostCapability = (env: NodeJS.ProcessEnv): Effect.Effect<string | undefined> =>
  Effect.sync(() => {
    const usable = (value: string | undefined) =>
      value !== undefined && Buffer.byteLength(value, "utf8") >= MIN_CAPABILITY_BYTES
        ? value
        : undefined;
    const direct = usable(env[COMPUTER_HOST_CAPABILITY_ENV]?.trim());
    const rawFd = env[COMPUTER_HOST_CAPABILITY_FD_ENV]?.trim();
    delete env[COMPUTER_HOST_CAPABILITY_ENV];
    delete env[COMPUTER_HOST_CAPABILITY_FD_ENV];
    const fd = rawFd && /^\d+$/.test(rawFd) ? Number(rawFd) : undefined;
    if (fd === undefined || fd < 3 || fd > 255) return direct;
    try {
      // Read the descriptor itself: `/dev/fd/N` fails with ENXIO on a Linux socket.
      return direct ?? usable(NodeFS.readFileSync(fd, "utf8").trim());
    } catch {
      return undefined;
    } finally {
      try {
        NodeFS.closeSync(fd);
      } catch {
        // The runtime may already have closed the one-shot descriptor.
      }
    }
  });

export const makeComputerServiceLayer = (options: ComputerServiceLiveOptions = {}) =>
  Layer.effect(
    ComputerService,
    Effect.gen(function* () {
      const plan: BackendPlan = options.backend
        ? { kind: "ready", backend: options.backend }
        : yield* planBackend(options.linuxBackends);
      // Linux selection and its passive probe share one startup budget. What
      // is known when it runs out is what the manager starts on; the rest
      // arrives in the background.
      const linux =
        plan.kind === "linux"
          ? yield* startLinuxBackend(
              plan,
              options.selectionBudgetMs ?? COMPUTER_SELECTION_STARTUP_BUDGET_MS,
            )
          : undefined;
      const backend = linux?.backend ?? (plan as ReadyBackendPlan).backend;
      const config = yield* Effect.serviceOption(ServerConfig);
      if (Option.isNone(config)) {
        yield* Effect.logWarning("computer state dir unavailable; using in-memory control state");
      }
      const manager = yield* ComputerManager.make({
        backend,
        approvals: yield* ComputerApprovalGate,
        ...(Option.isSome(config) ? { stateDir: config.value.stateDir } : {}),
      });
      if (linux) {
        // Every occupant change from here on is a desktop operation of its
        // own: see `ComputerManager.replaceDesktop`.
        linux.serializeSwaps((swap) => manager.replaceDesktop(swap));
        // Runs before the manager's own teardown, so no late selection or
        // reselection lands on a manager that is going away.
        yield* Effect.addFinalizer(() => linux.stop);
      }
      let availability: ComputerAvailability;
      if (options.supported === undefined) {
        // The passive probe, never the establishing read. Boot runs for every
        // user of every build, long before anyone has asked for a desktop —
        // and on a Linux compositor backend the establishing read installs a
        // plugin and loads it into the live desktop.
        availability = linux ? yield* linux.probeWithinBudget : yield* passiveProbe(backend);
      } else if (options.supported) {
        availability = { kind: "available", backend: "test-override" };
      } else {
        availability = {
          kind: "backend-unavailable",
          message: "Computer support is disabled by the service configuration.",
        };
      }
      return {
        // Supported backends stay routable before setup grants access, and so
        // does a slot still selecting its tier. Read as the slot's occupant
        // changes: selection may land on no backend at all.
        get supported() {
          return (
            options.supported ??
            !((linux?.current() ?? backend) instanceof UnavailableComputerBackend)
          );
        },
        // A Linux probe that outlived the budget lands here when it answers.
        get availability() {
          return options.supported === undefined && linux
            ? (linux.probedAvailability() ?? availability)
            : availability;
        },
        manager,
      } satisfies ComputerServiceShape;
    }),
  );

const passiveProbe = (backend: ComputerBackend): Effect.Effect<ComputerAvailability> =>
  backend.probeAvailability().pipe(
    Effect.catch((error) =>
      Effect.succeed<ComputerAvailability>({
        kind: "backend-unavailable",
        message: error.message,
      }),
    ),
  );

interface SelectedBackend {
  readonly backend: ComputerBackend;
  /** The Linux tier, when selection chose one; compared on re-selection. */
  readonly choice?: LinuxBackendChoice;
  /** Disposes the backend and closes the scope it was built in. */
  readonly release: Effect.Effect<void>;
}

/**
 * What startup does to find its backend: use one it already has, or run Linux
 * selection, which asks the session bus and so may take as long as a wedged
 * bus makes it. `forced` is an explicit override, which is never re-selected.
 */
type BackendPlan = ReadyBackendPlan | LinuxBackendPlan;

interface ReadyBackendPlan {
  readonly kind: "ready";
  readonly backend: ComputerBackend;
}

interface LinuxBackendPlan {
  readonly kind: "linux";
  readonly forced: boolean;
  /** Selects and builds a backend in a scope of its own; runs again on reselection. */
  readonly select: Effect.Effect<SelectedBackend>;
}

/**
 * The backend this server drives, in order: the explicit override, the Linux
 * tier that claims this host, the Cua host where one is reachable, and
 * otherwise a backend that says why there is none.
 *
 * An override is honored or refused, never bypassed: a malformed value and a
 * Linux choice off Linux both become the unavailable backend carrying the
 * reason, so an operator typo shows up as an availability card listing the
 * backends that do exist rather than as a different backend that seems to
 * ignore the variable.
 *
 * Cua comes after the Linux tiers on purpose. The desktop app always
 * configures its host socket, on Linux too, so socket presence cannot be what
 * decides between a compositor backend and the observation-only Cua host;
 * Cua on Linux is reached by naming it, or as what is left when no tier
 * claims the host.
 */
const planBackend = Effect.fn("ComputerService.planBackend")(function* (
  linuxBackends: ComputerServiceLiveOptions["linuxBackends"],
) {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const scope = yield* Effect.scope;
  // The capability is consumed on first read, and reselection may build the
  // Cua host again.
  const capability = yield* Effect.cached(resolveHostCapability(env));
  const makeCua = Effect.flatMap(capability, (resolved) =>
    makeCuaComputerBackend({
      endpoint: env[CUA_HOST_SOCKET_ENV]?.trim() || undefined,
      capability: resolved,
    }),
  );
  const ready = (backend: ComputerBackend): BackendPlan => ({ kind: "ready", backend });

  const parsed = yield* Effect.result(parseComputerBackendOverride(env[COMPUTER_BACKEND_ENV]));
  if (parsed._tag === "Failure") {
    return ready(yield* makeUnavailableComputerBackend(parsed.failure.message));
  }
  const override = parsed.success;
  if (override === "fake") return ready(new FakeComputerBackend());
  if (override === "cua") return ready(yield* makeCua);
  if (isLinuxBackendChoice(override) && platform !== "linux") {
    return ready(
      yield* makeUnavailableComputerBackend(
        `${COMPUTER_BACKEND_ENV}=${override} names a Linux desktop backend, and this server runs on ${platform}.`,
        { availability: { kind: "unsupported-platform", platform } },
      ),
    );
  }
  const fallback = fallbackBackend(platform, env, makeCua);
  if (platform !== "linux") return ready(yield* fallback);
  const forcedChoice = isLinuxBackendChoice(override) ? override : undefined;
  const select = Effect.gen(function* () {
    const linux = yield* selectLinuxBackend({
      env,
      ...(forcedChoice !== undefined ? { override: forcedChoice } : {}),
    });
    const own = yield* Scope.fork(scope);
    // Annotated: with no tier registered the choice is `never`, and so would
    // the factory be.
    const make: Effect.Effect<ComputerBackend, never, Scope.Scope> = linux
      ? (linuxBackends?.[linux.choice] ?? LINUX_BACKENDS[linux.choice])
      : fallback;
    const backend = yield* Scope.provide(own)(make);
    return {
      backend,
      ...(linux ? { choice: linux.choice } : {}),
      release: Effect.andThen(backend.dispose(), Scope.close(own, Exit.void)),
    } satisfies SelectedBackend;
  });
  return { kind: "linux", forced: forcedChoice !== undefined, select } satisfies BackendPlan;
});

/**
 * Where selection lands when no Linux tier claims the host, and on every other
 * platform. macOS runs the bundled host the desktop app provisions; elsewhere
 * the same backend is routable when a host endpoint is configured explicitly.
 * No endpoint means no backend: the gate is reachability, never platform
 * optimism.
 */
const fallbackBackend = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  makeCua: Effect.Effect<ComputerBackend, never, Scope.Scope>,
): Effect.Effect<ComputerBackend, never, Scope.Scope> =>
  platform === "darwin" || env[CUA_HOST_SOCKET_ENV]?.trim()
    ? makeCua
    : makeUnavailableComputerBackend(
        `No computer backend is configured for this server running on ${platform}.`,
        {
          availability:
            platform === "linux"
              ? {
                  kind: "backend-unavailable",
                  message: "No computer backend is available on this server.",
                }
              : { kind: "unsupported-platform", platform },
        },
      );

/**
 * Linux backend selection, off the startup path.
 *
 * Selection and the passive probe both ask the session bus, and a wedged bus
 * answers each question only at its D-Bus timeout. Startup waits for
 * selection for at most the budget; the manager is built on a slot holding the
 * selected backend, or a "checking" placeholder when selection is still
 * running, and the slot takes the selected backend whenever it arrives. The
 * probe gets what is left of the same budget.
 *
 * It also answers `desktop-gone`: when the occupant's desktop has ended for
 * good, selection runs again and a different tier replaces it. An explicit
 * override is never re-selected — the operator named that backend, and a
 * silent fallback would hand the agent a desktop nobody chose.
 */
const startLinuxBackend = Effect.fn("ComputerService.startLinuxBackend")(function* (
  plan: LinuxBackendPlan,
  budgetMs: number,
) {
  const scope = yield* Effect.scope;
  const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
  const selecting = yield* Effect.forkIn(plan.select, scope, { startImmediately: true });
  const early = yield* Fiber.join(selecting).pipe(Effect.timeoutOption(budgetMs));

  const checking = new CheckingComputerBackend(CHECKING_MESSAGE);
  const state = {
    current: Option.getOrElse(
      early,
      (): SelectedBackend => ({ backend: checking, release: Effect.void }),
    ),
    probedAvailability: undefined as ComputerAvailability | undefined,
    reselecting: false,
    stopped: false,
    // How a swap reaches the slot once the manager exists; see `serializeSwaps`.
    runSwap: (swap: Effect.Effect<void>): Effect.Effect<void> => swap,
  };

  const adopt = (selected: SelectedBackend, options?: ComputerBackendSwapOptions) =>
    Effect.suspend(() => {
      state.current = selected;
      return state.runSwap(slot.swap(selected.backend, options));
    });

  const reselect = (gone: ComputerBackend): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (plan.forced || state.reselecting || state.stopped) return Effect.void;
      state.reselecting = true;
      const replaced = state.current;
      return plan.select.pipe(
        Effect.flatMap((next) =>
          // The same tier again is the occupant's own reconnect to handle (a
          // backend that reports desktop-gone keeps looking for its desktop;
          // see the event's contract); a newer occupant already replaced the
          // one that reported.
          state.stopped || slot.current() !== gone || next.choice === replaced.choice
            ? next.release
            : Effect.andThen(adopt(next, { desktopChanged: true }), replaced.release),
        ),
        Effect.ensuring(Effect.sync(() => (state.reselecting = false))),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });

  const slot = yield* makeSwitchableComputerBackend(state.current.backend, {
    onDesktopGone: reselect,
  });

  // The selected backend, once known; `undefined` when the service stopped first.
  const settled = yield* Deferred.make<ComputerBackend | undefined>();
  if (Option.isSome(early)) {
    yield* Deferred.succeed(settled, early.value.backend);
  } else {
    yield* Fiber.join(selecting).pipe(
      Effect.flatMap((selected) =>
        state.stopped
          ? Effect.as(selected.release, undefined)
          : Effect.as(adopt(selected), selected.backend),
      ),
      Effect.flatMap((backend) => Deferred.succeed(settled, backend)),
      Effect.forkIn(scope),
    );
  }

  return {
    backend: slot.backend,
    current: slot.current,
    probedAvailability: () => state.probedAvailability,
    /**
     * Routes every later occupant change through `run` — the manager's desktop
     * operation queue — so a swap never lands in the middle of an action.
     * Until the manager exists nothing can be running, and swaps apply
     * directly.
     */
    serializeSwaps: (run: (swap: Effect.Effect<void>) => Effect.Effect<void>) => {
      state.runSwap = run;
    },
    /** The passive probe of the selected backend, or "checking" past the budget. */
    probeWithinBudget: Effect.gen(function* () {
      const probing = yield* Deferred.await(settled).pipe(
        Effect.flatMap((backend) =>
          backend === undefined ? Effect.undefined : passiveProbe(backend),
        ),
        Effect.tap((late) =>
          Effect.sync(() => {
            if (late !== undefined) state.probedAvailability = late;
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      const remaining = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
      const inBudget = yield* Fiber.join(probing).pipe(Effect.timeoutOption(remaining));
      return Option.getOrUndefined(inBudget) ?? checkingAvailability;
    }),
    stop: Effect.sync(() => {
      state.stopped = true;
    }),
  };
});

const checkingAvailability: ComputerAvailability = { kind: "checking", message: CHECKING_MESSAGE };

export const ComputerServiceLive = makeComputerServiceLayer();
