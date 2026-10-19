import "fake-indexeddb/auto";
import { describe, expect, it } from "vite-plus/test";
import { createThreadAlertLeadership, type AlertLockManager } from "./leadership.ts";
import { claimAlertDelivery, releaseAlertLease } from "./storage.ts";
import type { AlertDeliveryEvent } from "./index.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function lockManager(): AlertLockManager {
  let held = false;
  const waiting: Array<() => void> = [];
  return {
    request: (_name, options, callback) =>
      new Promise((resolve, reject) => {
        let started = false;
        const begin = () => {
          started = true;
          held = true;
          void callback()
            .then(resolve, reject)
            .finally(() => {
              held = false;
              waiting.shift()?.();
            });
        };
        options.signal.addEventListener("abort", () => {
          if (started) return;
          const index = waiting.indexOf(begin);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error("aborted"));
        });
        if (held) waiting.push(begin);
        else begin();
      }),
  };
}
const NOW = 1_800_000_000_000;
const event: AlertDeliveryEvent = {
  eventId: "while-offline",
  environmentId: "env",
  threadId: "thread",
  kind: "failed",
  createdAt: NOW,
  threadTitle: "Thread",
  projectName: "Project",
  alertEligibleAtCreation: true,
};
const cycle = (events: readonly AlertDeliveryEvent[]) => ({
  events,
  now: NOW,
  quiet: false,
  catchUp: true,
  eligible: () => true,
});

describe("alert ownership connection lifecycle", () => {
  it("hands a disconnected owner's events to a connected follower and does not replay on reacquisition", async () => {
    const locks = lockManager();
    let firstOwns = false;
    let secondOwns = false;
    let firstAcquired = deferred();
    const secondAcquired = deferred();
    const first = createThreadAlertLeadership({
      name: "account",
      locks,
      releaseLease: () => releaseAlertLease("handoff", "first"),
      onChange: (value) => {
        firstOwns = value;
        if (value) firstAcquired.resolve();
      },
    });
    const second = createThreadAlertLeadership({
      name: "account",
      locks,
      releaseLease: () => releaseAlertLease("handoff", "second"),
      onChange: (value) => {
        secondOwns = value;
        if (value) secondAcquired.resolve();
      },
    });
    await first.setConnected(true);
    await firstAcquired.promise;
    await claimAlertDelivery("handoff", "first", cycle([]));
    await second.setConnected(true);
    expect(secondOwns).toBe(false);
    await first.setConnected(false);
    await secondAcquired.promise;
    expect(firstOwns).toBe(false);
    expect((await claimAlertDelivery("handoff", "second", cycle([event])))?.actions).toHaveLength(
      1,
    );
    firstAcquired = deferred();
    await first.setConnected(true);
    expect(firstOwns).toBe(false);
    await second.dispose();
    await firstAcquired.promise;
    expect((await claimAlertDelivery("handoff", "first", cycle([event])))?.actions).toEqual([]);
    await first.dispose();
  });
  it("cancels a waiting disconnected tab without letting it own the lock later", async () => {
    const locks = lockManager();
    let waitingOwns = false;
    const owner = createThreadAlertLeadership({
      name: "account",
      locks,
      releaseLease: async () => {},
      onChange: () => {},
    });
    const waiting = createThreadAlertLeadership({
      name: "account",
      locks,
      releaseLease: async () => {},
      onChange: (value) => {
        waitingOwns = value;
      },
    });
    await owner.setConnected(true);
    await waiting.setConnected(true);
    await waiting.setConnected(false);
    await owner.dispose();
    expect(waitingOwns).toBe(false);
    await waiting.dispose();
  });
  it("keeps ownership when connection readiness is unchanged and releases a fallback lease on disconnect", async () => {
    const changes: boolean[] = [];
    let releases = 0;
    const leader = createThreadAlertLeadership({
      name: "account",
      locks: undefined,
      releaseLease: async () => {
        releases += 1;
      },
      onChange: (value) => changes.push(value),
    });
    await leader.setConnected(true);
    // Policy and notification readiness can pause delivery without changing the connection.
    await leader.setConnected(true);
    expect(changes).toEqual([true]);
    await leader.setConnected(false);
    expect(changes).toEqual([true, false]);
    expect(releases).toBe(1);
    await leader.dispose();
  });
});
