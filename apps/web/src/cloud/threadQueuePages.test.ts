import { describe, expect, it, vi } from "vite-plus/test";
import type { ThreadQueuePage } from "@spiritdevs/contracts/threadQueue";
import { subscribeThreadQueuePages } from "./threadQueuePages";

describe("bounded reactive queue pages", () => {
  it("loads past the first page and fences invalidated cursors and stopped accounts", () => {
    const subscriptions: Array<{
      cursor: string | null;
      update: (page: ThreadQueuePage) => void;
      stop: ReturnType<typeof vi.fn>;
    }> = [];
    const receive = vi.fn();
    const stop = subscribeThreadQueuePages((cursor, update) => {
      const stop = vi.fn();
      subscriptions.push({ cursor, update, stop });
      return stop;
    }, receive);
    subscriptions[0]!.update({ page: [], isDone: false, continueCursor: "second" });
    expect(subscriptions[1]?.cursor).toBe("second");
    expect(receive).toHaveBeenLastCalledWith([], false);
    subscriptions[1]!.update({ page: [], isDone: true, continueCursor: "end" });
    expect(receive).toHaveBeenLastCalledWith([], true);
    subscriptions[0]!.update({ page: [], isDone: false, continueCursor: "replacement" });
    expect(subscriptions[1]!.stop).toHaveBeenCalledOnce();
    expect(subscriptions[2]?.cursor).toBe("replacement");
    const calls = receive.mock.calls.length;
    subscriptions[1]!.update({ page: [], isDone: true, continueCursor: "old" });
    expect(receive).toHaveBeenCalledTimes(calls);
    stop();
    subscriptions[2]!.update({ page: [], isDone: true, continueCursor: "end" });
    expect(receive).toHaveBeenCalledTimes(calls);
    expect(subscriptions[0]!.stop).toHaveBeenCalledOnce();
    expect(subscriptions[2]!.stop).toHaveBeenCalledOnce();
  });
});
