import { describe, expect, it, vi } from "vite-plus/test";
import { createThreadAlertClickSubscription } from "./threadAlertClickQueue.ts";

const target = { environmentId: "environment-a", threadId: "thread-a", eventId: "event-a" };

describe("thread alert click subscriptions", () => {
  it("delivers an in-flight consumed click to the replacement listener", async () => {
    const response = Promise.withResolvers<readonly (typeof target)[]>();
    const received = Promise.withResolvers<typeof target | null>();
    const removeListener = vi.fn();
    const consume = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue([]);
    const subscribe = createThreadAlertClickSubscription({ consume, listen: () => removeListener });
    const oldListener = vi.fn();
    const stopOld = subscribe(oldListener);
    stopOld();
    const stopNew = subscribe(received.resolve);
    response.resolve([target]);
    expect(await received.promise).toEqual(target);
    expect(oldListener).not.toHaveBeenCalled();
    stopNew();
    expect(removeListener).toHaveBeenCalledTimes(2);
  });

  it("retains clicks consumed while no renderer listener is ready", async () => {
    const response = Promise.withResolvers<readonly (typeof target)[]>();
    const consume = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue([]);
    const subscribe = createThreadAlertClickSubscription({
      consume,
      listen: () => () => undefined,
    });
    const first = vi.fn();
    subscribe(first)();
    response.resolve([target]);
    await response.promise;
    const received = vi.fn();
    const stop = subscribe(received);
    expect(first).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledExactlyOnceWith(target);
    stop();
  });

  it("drains again when a new click signal arrives during an IPC request", async () => {
    const first = Promise.withResolvers<readonly (typeof target)[]>();
    const received = Promise.withResolvers<typeof target | null>();
    const consume = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce([target]);
    let signal: () => void = () => undefined;
    const subscribe = createThreadAlertClickSubscription({
      consume,
      listen: (receive) => {
        signal = receive;
        return () => undefined;
      },
    });
    const stop = subscribe(received.resolve);
    signal();
    first.resolve([]);
    expect(await received.promise).toEqual(target);
    expect(consume).toHaveBeenCalledTimes(2);
    stop();
  });
});
