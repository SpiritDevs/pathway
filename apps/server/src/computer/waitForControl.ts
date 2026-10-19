/**
 * Waiting on a semantic control to appear or disappear, by re-reading the
 * desktop rather than by sending input.
 *
 * @module computer/waitForControl
 */
import type { ComputerState, ComputerTarget } from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { type ComputerTargetError, resolveComputerSemanticTarget } from "./uiTreeTargeting.ts";

export interface ComputerControlReadiness {
  readonly status: "ready" | "timeout" | "unavailable" | "ambiguous" | "closed";
  readonly waitedMs: number;
}

/** Longest pause between two reads of the desktop. */
const POLL_INTERVAL_MS = 100;

/**
 * Wait for a live semantic target without sending input or retaining
 * coordinates. `read` is run once per poll. Cancelling the wait is
 * interrupting it: the fiber stops at the next read or pause.
 *
 * With `absent`, the wait is for the control to go away instead: its window
 * closing counts, while an ambiguous match still proves presence.
 */
export const waitForControl = Effect.fn("waitForControl")(function* <E, R>(
  read: Effect.Effect<ComputerState, E, R>,
  target: ComputerTarget,
  timeoutMs: number,
  options?: { readonly absent?: boolean },
): Effect.fn.Return<ComputerControlReadiness, E | ComputerTargetError, R> {
  const absent = options?.absent === true;
  const started = yield* Clock.currentTimeMillis;
  const result = (status: ComputerControlReadiness["status"]) =>
    Effect.map(
      Clock.currentTimeMillis,
      (now): ComputerControlReadiness => ({ status, waitedMs: Math.round(now - started) }),
    );
  while (true) {
    const state = yield* read;
    const windowId = target.windowId;
    if (windowId && !state.windows.some((window) => window.id === windowId)) {
      // The window going away removes its controls with it — "gone" for an
      // absent wait, "closed" for a presence wait.
      return yield* result(absent ? "ready" : "closed");
    }
    const root = state.root;
    if (
      !root ||
      state.accessibility?.status === "unavailable" ||
      (windowId && state.accessibility?.unavailableWindowIds?.includes(windowId))
    ) {
      return yield* result("unavailable");
    }
    const match = yield* resolveComputerSemanticTarget(root, target).pipe(
      Effect.as("present" as const),
      Effect.catchIf(
        (error) =>
          error.code === "computer_target_ambiguous" || error.code === "computer_target_not_found",
        (error) =>
          Effect.succeed(error.code === "computer_target_ambiguous" ? "ambiguous" : "missing"),
      ),
    );
    // An ambiguous match still proves presence — for a presence wait that is a
    // verdict to report; for an absent wait it means keep waiting.
    if (!absent && match !== "missing") {
      return yield* result(match === "present" ? "ready" : "ambiguous");
    }
    if (absent && match === "missing") return yield* result("ready");
    // A truncated walk cannot establish absence; repeating it burns time
    // without establishing readiness. Let the caller use a scoped screenshot.
    if (root.truncated) return yield* result("unavailable");
    const remaining = timeoutMs - ((yield* Clock.currentTimeMillis) - started);
    if (remaining <= 0) return yield* result("timeout");
    yield* Effect.sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
});
