import type { DeviceInput } from "@spiritdevs/contracts";
import { expect, it } from "vite-plus/test";
import { createDeviceInputQueue } from "./deviceInputQueue";

function harness() {
  const sent: DeviceInput[] = [];
  const replies: Array<(ok: boolean) => void> = [];
  let frame: (() => void) | null = null;
  const queue = createDeviceInputQueue({
    send: (input) => {
      sent.push(input);
      return new Promise((resolve) => replies.push(resolve));
    },
    requestFrame: (callback) => {
      frame = callback;
      return () => {
        frame = null;
      };
    },
  });
  const settle = async (ok = true) => {
    replies.shift()!(ok);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { queue, sent, settle, tick: () => frame?.() };
}

it("coalesces Crown deltas within a frame and bounds each message", async () => {
  const { queue, sent, settle, tick } = harness();
  queue.turnCrown(120);
  queue.turnCrown(150);
  queue.turnCrown(-20);
  expect(sent).toEqual([]);
  tick();
  expect(sent).toEqual([{ kind: "digitalCrown", delta: 200 }]);
  queue.turnCrown(30);
  await settle();
  expect(sent.at(-1)).toEqual({ kind: "digitalCrown", delta: 80 });
  await settle();
  expect(sent).toHaveLength(2);
});

it("sends presses in order, one at a time, and drops a backlog after a failure", async () => {
  const { queue, sent, settle } = harness();
  queue.press({ kind: "remoteButton", button: "down" });
  queue.press({ kind: "remoteButton", button: "select" });
  queue.press({ kind: "remoteButton", button: "back" });
  expect(sent).toEqual([{ kind: "remoteButton", button: "down" }]);
  await settle(false);
  expect(sent).toHaveLength(1);
  queue.press({ kind: "watchButton", button: "side" });
  expect(sent.at(-1)).toEqual({ kind: "watchButton", button: "side" });
});

it("bounds held-key repeats and forgets unsent input on cancel", async () => {
  const { queue, sent, settle, tick } = harness();
  for (let index = 0; index < 20; index++) queue.press({ kind: "remoteButton", button: "up" });
  queue.turnCrown(50);
  queue.cancel();
  tick();
  await settle();
  expect(sent).toHaveLength(1);
  queue.press({ kind: "remoteButton", button: "home" });
  expect(sent.at(-1)).toEqual({ kind: "remoteButton", button: "home" });
});

it("caps queued presses while one is in flight", async () => {
  const { queue, sent, settle } = harness();
  for (let index = 0; index < 20; index++) queue.press({ kind: "remoteButton", button: "up" });
  for (let index = 0; index < 9; index++) await settle();
  expect(sent).toHaveLength(9);
  queue.press({ kind: "remoteButton", button: "down" });
  expect(sent).toHaveLength(10);
});
