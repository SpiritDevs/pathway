import { describe, expect, it, vi } from "vite-plus/test";
import { createThreadAlertClickSubscription } from "./threadAlertClickQueue.ts";
import type { ThreadAlertTarget } from "@spiritdevs/contracts/threadAlerts";

const target = { environmentId: "environment-a", threadId: "thread-a", eventId: "event-a" };
const click = { userId: "account-a", target };

describe("thread alert click subscriptions", () => {
  it("delivers storage destinations without converting them to thread or tray targets", async () => {
    const storageTarget: ThreadAlertTarget = { kind: "storage", environmentId: "environment-a" };
    const received = Promise.withResolvers<ThreadAlertTarget>();
    const subscribe = createThreadAlertClickSubscription({
      consume: async () => [{ userId: "account-a", target: storageTarget }],
      listen: () => () => undefined,
    });
    const stop = subscribe("account-a", received.resolve);
    expect(await received.promise).toEqual(storageTarget);
    stop();
  });
  it("delivers an in-flight consumed click to the replacement listener", async () => {
    const response = Promise.withResolvers<readonly (typeof click)[]>();
    const received = Promise.withResolvers<ThreadAlertTarget>();
    const removeListener = vi.fn();
    const consume = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue([]);
    const subscribe = createThreadAlertClickSubscription({ consume, listen: () => removeListener });
    const oldListener = vi.fn();
    const stopOld = subscribe("account-a", oldListener);
    stopOld();
    const stopNew = subscribe("account-a", received.resolve);
    response.resolve([click]);
    expect(await received.promise).toEqual(target);
    expect(oldListener).not.toHaveBeenCalled();
    stopNew();
    expect(removeListener).toHaveBeenCalledTimes(2);
  });

  it("retains clicks consumed while no renderer listener is ready", async () => {
    const response = Promise.withResolvers<readonly (typeof click)[]>();
    const consume = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue([]);
    const subscribe = createThreadAlertClickSubscription({
      consume,
      listen: () => () => undefined,
    });
    const first = vi.fn();
    subscribe("account-a", first)();
    response.resolve([click]);
    await response.promise;
    const received = vi.fn();
    const stop = subscribe("account-a", received);
    expect(first).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledExactlyOnceWith(target);
    stop();
  });

  it("drains again when a new click signal arrives during an IPC request", async () => {
    const first = Promise.withResolvers<readonly (typeof click)[]>();
    const received = Promise.withResolvers<ThreadAlertTarget>();
    const consume = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce([click]);
    let signal: () => void = () => undefined;
    const subscribe = createThreadAlertClickSubscription({
      consume,
      listen: (receive) => {
        signal = receive;
        return () => undefined;
      },
    });
    const stop = subscribe("account-a", received.resolve);
    signal();
    first.resolve([]);
    expect(await received.promise).toEqual(target);
    expect(consume).toHaveBeenCalledTimes(2);
    stop();
  });
  it("does not deliver a previous account's buffered click after sign-in changes", async () => {
    const response = Promise.withResolvers<readonly (typeof click)[]>();
    const subscribe = createThreadAlertClickSubscription({
      consume: vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue([]),
      listen: () => () => undefined,
    });
    const oldListener = vi.fn();
    subscribe("account-a", oldListener)();
    response.resolve([click]);
    await response.promise;
    const currentListener = vi.fn();
    const stop = subscribe("account-b", currentListener);
    expect(oldListener).not.toHaveBeenCalled();
    expect(currentListener).not.toHaveBeenCalled();
    stop();
  });

  it("filters old-account clicks returned by an in-flight IPC request while preserving current clicks", async () => {
    const response = Promise.withResolvers<readonly (typeof click)[]>();
    const subscribe = createThreadAlertClickSubscription({
      consume: vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue([]),
      listen: () => () => undefined,
    });
    const oldListener = vi.fn();
    subscribe("account-a", oldListener)();
    const received = Promise.withResolvers<ThreadAlertTarget>();
    const currentListener = vi.fn(received.resolve);
    const stop = subscribe("account-b", currentListener);
    const currentTarget = { ...target, eventId: "current-event" };
    response.resolve([click, { userId: "account-b", target: currentTarget }]);
    expect(await received.promise).toEqual(currentTarget);
    expect(currentListener).toHaveBeenCalledExactlyOnceWith(currentTarget);
    expect(oldListener).not.toHaveBeenCalled();
    stop();
  });
});
