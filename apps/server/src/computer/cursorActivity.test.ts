import type { ProviderRuntimeEvent } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { cursorRuntimeActivity, cursorToolActivity, makeCursorActivity } from "./cursorActivity.ts";

/** Lets the debounce elapse, then lets the detached publish fiber run. */
const tick = TestClock.adjust("80 millis").pipe(
  Effect.andThen(Effect.yieldNow),
  Effect.andThen(Effect.yieldNow),
);

/** A publish that records every label it is handed. */
const recorder = <E = never>(after: Effect.Effect<void, E> = Effect.void) => {
  const labels: Array<string | null> = [];
  const publish = (text: string | null) =>
    Effect.suspend(() => {
      labels.push(text);
      return after;
    });
  return { labels, publish };
};

describe("cursor activity", () => {
  it.effect("shows live work, then thinking, without waiting on the badge backend", () =>
    Effect.gen(function* () {
      const { labels, publish } = recorder(Effect.never);
      const activity = yield* makeCursorActivity(publish);
      yield* activity.setOwner("owner");
      const finish = yield* Deferred.make<void>();
      const work = yield* Effect.forkChild(
        activity.during("owner", "Scrolling", Deferred.await(finish)),
        { startImmediately: true },
      );
      yield* tick;
      expect(labels).toEqual(["Scrolling"]);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(work);
      yield* tick;
      expect(labels).toEqual(["Scrolling", "Thinking"]);
      yield* activity.setOwner(null);
      yield* tick;
      expect(labels.at(-1)).toBeNull();
      yield* activity.dispose;
    }),
  );

  it.effect("coalesces brief calls and repeated token events", () =>
    Effect.gen(function* () {
      const { labels, publish } = recorder();
      const activity = yield* makeCursorActivity(publish);
      yield* activity.setOwner("owner");
      yield* activity.during("owner", "Clicking", Effect.void);
      for (let i = 0; i < 100; i++) yield* activity.setRuntime("owner", "Thinking");
      yield* tick;
      expect(labels).toEqual(["Thinking"]);
      yield* activity.dispose;
    }),
  );

  it.effect("ignores other threads and keeps pending work from overwriting a new owner", () =>
    Effect.gen(function* () {
      const { labels, publish } = recorder();
      const activity = yield* makeCursorActivity(publish);
      yield* activity.setOwner("a");
      const finish = yield* Deferred.make<void>();
      const work = yield* Effect.forkChild(activity.during("a", "Typing", Deferred.await(finish)), {
        startImmediately: true,
      });
      yield* activity.setOwner("b");
      yield* activity.setRuntime("a", "Waiting for you");
      yield* activity.setRuntime("b", "Needs approval");
      yield* tick;
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(work);
      yield* tick;
      expect(labels).toEqual(["Needs approval"]);
      yield* activity.dispose;
    }),
  );

  it.effect("keeps a pending question visible until its response arrives", () =>
    Effect.gen(function* () {
      const { labels, publish } = recorder();
      const activity = yield* makeCursorActivity(publish);
      yield* activity.setOwner("owner");
      yield* activity.setRuntime("owner", "Waiting for you");
      yield* activity.setRuntime("owner", "Responding");
      yield* activity.setRuntime("owner", "Thinking");
      yield* tick;
      expect(labels).toEqual(["Waiting for you"]);
      yield* activity.setRuntime("owner", "Thinking", true);
      yield* tick;
      expect(labels.at(-1)).toBe("Thinking");
      yield* activity.dispose;
    }),
  );

  it.effect("handles errors and disposal without failing input or publishing late labels", () =>
    Effect.gen(function* () {
      const { labels, publish } = recorder(Effect.fail("badge unavailable"));
      const activity = yield* makeCursorActivity(publish);
      yield* activity.setOwner("a");
      const error = yield* Effect.flip(activity.during("a", "Typing", Effect.fail("input failed")));
      expect(error).toBe("input failed");
      yield* tick;
      expect(labels).toEqual(["Needs attention"]);
      yield* activity.setRuntime("a", "Thinking");
      yield* activity.dispose;
      yield* tick;
      expect(labels).toHaveLength(1);
    }),
  );

  it("uses concise labels for actual events, without showing private content", () => {
    expect(cursorToolActivity("computer_scroll").length).toBeLessThanOrEqual(20);
    const event = (type: string, payload = {}) => ({ type, payload }) as ProviderRuntimeEvent;
    expect(cursorRuntimeActivity(event("user-input.requested"))).toBe("Waiting for you");
    expect(cursorRuntimeActivity(event("request.opened"))).toBe("Needs approval");
    expect(
      cursorRuntimeActivity(
        event("content.delta", { streamKind: "reasoning_text", delta: "private reasoning" }),
      ),
    ).toBe("Thinking");
    expect(cursorRuntimeActivity(event("session.exited"))).toBeUndefined();
  });

  it("labels the registered cursor tool and never echoes unknown tool names", () => {
    const expected = {
      computer_screenshot: "Capturing screen",
      computer_get_state: "Reading screen",
      computer_get_screen_size: "Measuring screen",
      computer_list_windows: "Finding window",
      computer_click: "Clicking",
      computer_move_cursor: "Moving cursor",
      computer_drag: "Dragging",
      computer_scroll: "Scrolling",
      computer_type_text: "Typing",
      computer_press_key: "Pressing key",
      computer_set_value: "Setting field",
      computer_select_text: "Selecting text",
      computer_perform_action: "Activating control",
      computer_launch_app: "Opening app",
      computer_activate_window: "Activating window",
      computer_wait: "Waiting for screen",
      computer_read_clipboard: "Reading clipboard",
      computer_write_clipboard: "Writing clipboard",
      computer_paste: "Pasting",
      computer_run: "Running sequence",
    } as const;
    for (const [tool, label] of Object.entries(expected)) {
      expect(cursorToolActivity(tool)).toBe(label);
      expect(label.length).toBeLessThanOrEqual(20);
    }
    expect(cursorToolActivity("computer_move")).toBe("Working");
    expect(cursorToolActivity("unknown tool containing private text")).toBe("Working");
  });
});
