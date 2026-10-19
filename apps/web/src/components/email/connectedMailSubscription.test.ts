import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mailQueryErrorMessage, subscribeMailWithDeadline } from "./connectedMailSubscription";

afterEach(() => {
  vi.useRealTimers();
});

describe("mail subscription deadline", () => {
  it("shows an actionable error if the service never answers and accepts later recovery", () => {
    vi.useFakeTimers();
    let deliver: (value: string[]) => void = () => {};
    const receive = vi.fn();
    const reject = vi.fn();
    const close = subscribeMailWithDeadline<string[]>(
      (next) => {
        deliver = next;
        return () => {};
      },
      receive,
      reject,
    );
    vi.advanceTimersByTime(20_000);
    expect(reject).toHaveBeenCalledOnce();
    expect(reject.mock.calls[0]?.[0].message).toContain("Check your connection");
    deliver(["mailbox"]);
    expect(receive).toHaveBeenCalledWith(["mailbox"]);
    close();
  });
  it.each(["value", "error"] as const)("cancels the deadline after a subscription %s", (kind) => {
    vi.useFakeTimers();
    const receive = vi.fn();
    const reject = vi.fn();
    const error = new Error("Sign in again.");
    subscribeMailWithDeadline<string[]>(
      (next, fail) => {
        if (kind === "value") next([]);
        else fail(error);
        return () => {};
      },
      receive,
      reject,
    );
    vi.advanceTimersByTime(30_000);
    expect(reject).toHaveBeenCalledTimes(kind === "error" ? 1 : 0);
    if (kind === "error") expect(reject).toHaveBeenCalledWith(error);
  });
  it("cancels an old workspace's deadline and ignores its late subscription result", () => {
    vi.useFakeTimers();
    let deliver: (value: string[]) => void = () => {};
    const unsubscribe = vi.fn();
    const receive = vi.fn();
    const reject = vi.fn();
    const close = subscribeMailWithDeadline<string[]>(
      (next) => {
        deliver = next;
        return unsubscribe;
      },
      receive,
      reject,
    );
    close();
    deliver(["old private mailbox"]);
    vi.advanceTimersByTime(30_000);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(receive).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });
  it("reports a synchronous subscription failure without leaving a deadline behind", () => {
    vi.useFakeTimers();
    const reject = vi.fn();
    const cause = new Error("Service unavailable");
    subscribeMailWithDeadline(
      () => {
        throw cause;
      },
      vi.fn(),
      reject,
    );
    vi.advanceTimersByTime(30_000);
    expect(reject).toHaveBeenCalledExactlyOnceWith(cause);
  });
  it("does not expose missing function internals to the user", () => {
    const message = mailQueryErrorMessage(
      new Error(
        "[CONVEX Q(mail:listAccounts)] Could not find public function for mail:listAccounts",
      ),
    );
    expect(message).toContain("workspace administrator");
    expect(message).not.toContain("mail:listAccounts");
  });
});
