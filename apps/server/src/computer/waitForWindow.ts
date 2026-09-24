/**
 * Launch window readiness: which window a just-launched app gave us, if any.
 *
 * @module computer/waitForWindow
 */
import type { ComputerLaunchAppResult, ComputerWindow } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export type ComputerWindowReadiness = Pick<
  ComputerLaunchAppResult,
  "window" | "windowStatus" | "windowReason"
>;

/**
 * What the launch itself established about the process it started.
 *
 * `pid` alone is the historical rule and stays exact: a window of that
 * process, and no other. `appId` is a backend's statement that the pid may be
 * a launcher's (flatpak, `gio launch` and single-instance apps hand the window
 * to a different process), so a window of that app identity counts too, as
 * does the launch name, whenever no window carries the pid.
 */
export interface WaitForWindowTarget<E, R> {
  readonly pid?: number;
  readonly appId?: string;
  readonly checkInputReady?: (windowId: string) => Effect.Effect<void, E, R>;
}

const unavailable = (
  windowReason: NonNullable<ComputerLaunchAppResult["windowReason"]>,
): ComputerWindowReadiness => ({
  window: null,
  windowStatus: "no_usable_window",
  windowReason,
});

/** Longest the whole probe may take, however long the caller allowed. */
const PROBE_BUDGET_MS = 2_000;
const POLL_INTERVAL_MS = 150;

/**
 * Match an app name/path conservatively; ambiguity never picks a window.
 *
 * A hung list or accessibility probe must not defeat the readiness budget, so
 * the probe is interrupted at the budget and any failure reads as
 * `input_unavailable`: the launch has already been sent and is never replayed
 * or described as not dispatched. Interrupting the caller (Stop) still
 * interrupts this wait rather than reporting readiness.
 */
export const waitForWindow = <E1, R1, E2 = never, R2 = never>(
  read: Effect.Effect<readonly ComputerWindow[], E1, R1>,
  app: string,
  timeoutMs: number,
  target?: WaitForWindowTarget<E2, R2>,
): Effect.Effect<ComputerWindowReadiness, never, R1 | R2> =>
  probeWindow(read, app, timeoutMs, target).pipe(
    Effect.timeoutOption(Math.min(PROBE_BUDGET_MS, Math.max(1, timeoutMs || PROBE_BUDGET_MS))),
    Effect.map(Option.getOrElse(() => unavailable("input_unavailable"))),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.succeed(unavailable("input_unavailable")),
    ),
  );

const probeWindow = Effect.fnUntraced(function* <E1, R1, E2, R2>(
  read: Effect.Effect<readonly ComputerWindow[], E1, R1>,
  app: string,
  timeoutMs: number,
  target: WaitForWindowTarget<E2, R2> | undefined,
) {
  const name = launchName(app);
  const deadline =
    (yield* Clock.currentTimeMillis) + Math.min(PROBE_BUDGET_MS, Math.max(0, timeoutMs));
  while (true) {
    const matches = launchedWindows(yield* read, name, target);
    // Titles, visibility and size do not prove which same-app window is the
    // requested document. Keep the choice explicit when siblings exist.
    if (matches.length > 1) return unavailable("ambiguous");
    const candidate = matches[0];
    const reason = !candidate
      ? "no_window"
      : candidate.onCurrentSpace === false
        ? "off_space"
        : !candidate.visible || candidate.minimized
          ? "hidden"
          : undefined;
    if (candidate && reason === undefined) {
      const ready: ComputerWindowReadiness = { window: candidate, windowStatus: "ready" };
      if (!target?.checkInputReady) return ready;
      return yield* target.checkInputReady(candidate.id).pipe(
        Effect.as(ready),
        Effect.orElseSucceed(() => unavailable("input_unavailable")),
      );
    }
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) return unavailable(reason ?? "input_unavailable");
    yield* Effect.sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
});

function launchName(app: string): string | undefined {
  return app
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.app$/i, "")
    .toLocaleLowerCase();
}

/** A desktop entry id names its app with or without the `.desktop` suffix. */
function withoutDesktopSuffix(name: string | undefined): string | undefined {
  return name?.replace(/\.desktop$/i, "");
}

/**
 * The windows this launch may have produced. Without an app identity the rule
 * is the one every backend always had: the pid when the launch reported one,
 * else the launch name against `appName`. With one, the pid still wins when any
 * window carries it, and otherwise the identity or the launch name may match,
 * because the reported pid belongs to a process that hands the window on.
 */
function launchedWindows(
  windows: readonly ComputerWindow[],
  name: string | undefined,
  target: { readonly pid?: number; readonly appId?: string } | undefined,
): readonly ComputerWindow[] {
  const pid = target?.pid;
  if (target?.appId === undefined) {
    return windows.filter((window) =>
      pid !== undefined ? window.pid === pid : window.appName?.toLocaleLowerCase() === name,
    );
  }
  if (pid !== undefined) {
    const byPid = windows.filter((window) => window.pid === pid);
    if (byPid.length > 0) return byPid;
  }
  const names = new Set(
    [withoutDesktopSuffix(launchName(target.appId)), withoutDesktopSuffix(name)].filter(
      (entry): entry is string => entry !== undefined && entry.length > 0,
    ),
  );
  return windows.filter((window) => {
    const appName = withoutDesktopSuffix(window.appName?.toLocaleLowerCase());
    return appName !== undefined && names.has(appName);
  });
}
