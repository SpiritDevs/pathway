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

export interface WaitForWindowTarget<E, R> {
  readonly pid?: number;
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
  const name = app
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.app$/i, "")
    .toLocaleLowerCase();
  const deadline =
    (yield* Clock.currentTimeMillis) + Math.min(PROBE_BUDGET_MS, Math.max(0, timeoutMs));
  while (true) {
    const matches = (yield* read).filter((window) =>
      target?.pid !== undefined
        ? window.pid === target.pid
        : window.appName?.toLocaleLowerCase() === name,
    );
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
