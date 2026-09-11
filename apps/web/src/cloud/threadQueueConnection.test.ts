import { expect, it, vi } from "vite-plus/test";
import { watchQueueConnection, awaitQueueMutation } from "./threadQueueConnection";

it("invalidates a disconnected session once and ignores its stale reconnect", () => {
  let receive = (_state: { isWebSocketConnected: boolean }) => {};
  const invalidate = vi.fn();
  const connected = vi.fn();
  const stop = vi.fn();
  const unsubscribe = watchQueueConnection(
    {
      connectionState: () => ({ isWebSocketConnected: false }),
      subscribeToConnectionState: (callback) => {
        receive = callback;
        return stop;
      },
    },
    invalidate,
    connected,
  );
  receive({ isWebSocketConnected: false });
  expect(invalidate).not.toHaveBeenCalled();
  receive({ isWebSocketConnected: true });
  expect(connected).toHaveBeenCalledOnce();
  receive({ isWebSocketConnected: false });
  expect(invalidate).toHaveBeenCalledOnce();
  receive({ isWebSocketConnected: true });
  receive({ isWebSocketConnected: false });
  expect(connected).toHaveBeenCalledOnce();
  expect(invalidate).toHaveBeenCalledOnce();
  unsubscribe();
  expect(stop).toHaveBeenCalledOnce();
});

it("releases an interrupted queue action without waiting for the abandoned mutation", async () => {
  const mutation = new Promise<string>(() => {});
  let close = () => {};
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const result = awaitQueueMutation(mutation, closed);
  close();
  await expect(result).rejects.toThrow("Check the thread state before retrying");
});

it("returns a completed queue action normally", async () => {
  let close = () => {};
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  await expect(awaitQueueMutation(Promise.resolve("saved"), closed)).resolves.toBe("saved");
  close();
});
