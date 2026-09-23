/**
 * The short label the desktop cursor badge shows while an agent works: which
 * tool is running, or what the owning thread is doing between tools.
 *
 * @module computer/cursorActivity
 */
import type { ProviderRuntimeEvent } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

/** Short, factual labels. Never display arguments, typed text, or model reasoning. */
export function cursorToolActivity(tool: string): string {
  switch (tool) {
    case "computer_click":
      return "Clicking";
    case "computer_scroll":
      return "Scrolling";
    case "computer_type_text":
      return "Typing";
    case "computer_set_value":
      return "Setting field";
    case "computer_select_text":
      return "Selecting text";
    case "computer_paste":
      return "Pasting";
    case "computer_press_key":
      return "Pressing key";
    case "computer_drag":
      return "Dragging";
    case "computer_move_cursor":
      return "Moving cursor";
    case "computer_wait":
      return "Waiting for screen";
    case "computer_screenshot":
      return "Capturing screen";
    case "computer_get_state":
      return "Reading screen";
    case "computer_get_screen_size":
      return "Measuring screen";
    case "computer_list_windows":
      return "Finding window";
    case "computer_list_apps":
      return "Listing apps";
    case "computer_set_window_frame":
      return "Moving window";
    case "computer_invoke_menu":
      return "Opening menu item";
    case "computer_verify_state":
      return "Checking state";
    case "computer_zoom":
      return "Zooming in";
    case "computer_get_accessibility_tree":
      return "Reading desktop inventory";
    case "computer_get_cursor_position":
      return "Reading cursor position";
    case "computer_kill_app":
      return "Force-quitting app";
    case "computer_set_window_minimized":
      return "Changing window visibility";
    case "computer_set_app_visibility":
      return "Changing app visibility";
    case "computer_perform_action":
      return "Activating control";
    case "computer_launch_app":
      return "Opening app";
    case "computer_activate_window":
      return "Activating window";
    case "computer_read_clipboard":
      return "Reading clipboard";
    case "computer_write_clipboard":
      return "Writing clipboard";
    case "computer_run":
      return "Running sequence";
    default:
      return "Working";
  }
}

export function cursorRuntimeActivity(event: ProviderRuntimeEvent): string | undefined {
  switch (event.type) {
    case "user-input.requested":
      return "Waiting for you";
    case "request.opened":
      return "Needs approval";
    case "user-input.resolved":
    case "request.resolved":
    case "turn.started":
    case "item.completed":
      return "Thinking";
    case "item.started":
      return "Working";
    case "content.delta":
      if (event.payload.streamKind === "assistant_text") return "Responding";
      if (
        ["reasoning_text", "reasoning_summary_text", "plan_text"].includes(event.payload.streamKind)
      )
        return "Thinking";
      return undefined;
    default:
      return undefined;
  }
}

/** How long a label must hold before it is published; brief tools never flash. */
const CURSOR_ACTIVITY_DEBOUNCE = "80 millis";
const QUESTION_LABELS: ReadonlySet<string> = new Set(["Waiting for you", "Needs approval"]);

export interface CursorActivity {
  /** The thread whose activity the badge shows; null hides the badge. */
  readonly setOwner: (owner: string | null) => Effect.Effect<void>;
  /**
   * The owner's between-tools state. An open question stays visible until
   * `resumed` says its response arrived, because content events keep flowing
   * while it is open.
   */
  readonly setRuntime: (thread: string, text: string, resumed?: boolean) => Effect.Effect<void>;
  /** Shows `text` while `action` runs, then "Thinking", or "Needs attention" if it failed. */
  readonly during: <A, E, R>(
    thread: string,
    text: string,
    action: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Stops publishing; a label already scheduled is dropped. */
  readonly dispose: Effect.Effect<void>;
}

/**
 * Cosmetic updates never block input. Debounce brief tools and deduplicate
 * token events. `publish` runs detached from the caller and its failures are
 * ignored, so a slow or broken badge cannot delay or fail an action. Timer and
 * publish fibers live in the caller's scope; closing it disposes the activity.
 */
export const makeCursorActivity = Effect.fnUntraced(function* <E>(
  publish: (text: string | null) => Effect.Effect<void, E>,
): Effect.fn.Return<CursorActivity, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  let owner: string | null = null;
  let base = "Thinking";
  const pending = new Map<symbol, { readonly thread: string; readonly text: string }>();
  let timer: Fiber.Fiber<void> | undefined;
  let scheduled = false;
  let last: string | null | undefined;
  let disposed = false;

  const flush = Effect.suspend(() => {
    scheduled = false;
    timer = undefined;
    const active = [...pending.values()].findLast((item) => item.thread === owner);
    const waiting = QUESTION_LABELS.has(base);
    const text = owner === null ? null : waiting ? base : (active?.text ?? base);
    if (text === last || disposed) return Effect.void;
    last = text;
    // Catch synchronous and asynchronous backend failures alike.
    return Effect.asVoid(
      Effect.forkIn(Effect.ignoreCause(Effect.suspend(() => publish(text))), scope),
    );
  });

  const schedule = Effect.suspend(() => {
    if (disposed || scheduled) return Effect.void;
    scheduled = true;
    return Effect.map(
      Effect.forkIn(Effect.andThen(Effect.sleep(CURSOR_ACTIVITY_DEBOUNCE), flush), scope),
      (fiber) => {
        if (scheduled) timer = fiber;
      },
    );
  });

  const setOwner = (next: string | null) =>
    Effect.suspend(() => {
      if (owner === next) return Effect.void;
      owner = next;
      base = "Thinking";
      return schedule;
    });

  const setRuntime = (thread: string, text: string, resumed = false) =>
    Effect.suspend(() => {
      if (thread !== owner || base === text) return Effect.void;
      // Content/item events may continue arriving while a question is open.
      if (!resumed && QUESTION_LABELS.has(base)) return Effect.void;
      base = text;
      return schedule;
    });

  const during = <A, E, R>(thread: string, text: string, action: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const token = Symbol();
      pending.set(token, { thread, text });
      return schedule.pipe(
        Effect.andThen(setRuntime(thread, "Thinking")),
        Effect.andThen(action),
        Effect.onError(() => setRuntime(thread, "Needs attention")),
        Effect.ensuring(
          Effect.suspend(() => {
            pending.delete(token);
            return schedule;
          }),
        ),
      );
    });

  const dispose = Effect.suspend(() => {
    disposed = true;
    pending.clear();
    const running = timer;
    timer = undefined;
    return running === undefined ? Effect.void : Fiber.interrupt(running);
  });

  yield* Effect.addFinalizer(() => dispose);
  return { setOwner, setRuntime, during, dispose } satisfies CursorActivity;
});
