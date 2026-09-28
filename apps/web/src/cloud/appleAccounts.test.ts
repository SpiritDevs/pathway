import type { ConvexClient } from "convex/browser";
import { describe, expect, it } from "vite-plus/test";

import {
  appleAccountFunctions,
  selectAppleCloudQueryState,
  subscribeAppleCloudQuery,
} from "./appleAccounts";

describe("selectAppleCloudQueryState", () => {
  it("hides state produced by another client or query", () => {
    const clientA = {};
    const clientB = {};
    const state = { client: clientA, key: "k", data: ["a"], error: undefined };
    expect(selectAppleCloudQueryState(state, clientA, "k").data).toEqual(["a"]);
    expect(selectAppleCloudQueryState(state, clientB, "k").data).toBeUndefined();
    expect(selectAppleCloudQueryState(state, clientA, "other").data).toBeUndefined();
    expect(selectAppleCloudQueryState(state, null, null).data).toBeUndefined();
  });
});

describe("subscribeAppleCloudQuery", () => {
  it("drops callbacks after unsubscribing", () => {
    const callbacks: Array<{ onData: (data: unknown) => void; onError: (e: Error) => void }> = [];
    let unsubscribed = 0;
    const client = {
      onUpdate: (_query: unknown, _args: unknown, onData: never, onError: never) => {
        callbacks.push({ onData, onError });
        return () => {
          unsubscribed += 1;
        };
      },
    } as unknown as Pick<ConvexClient, "onUpdate">;
    const received: unknown[] = [];
    const stop = subscribeAppleCloudQuery(client, appleAccountFunctions.listAccounts, {}, (next) =>
      received.push(next),
    );
    callbacks[0]!.onData([]);
    stop();
    callbacks[0]!.onData(["late"]);
    callbacks[0]!.onError(new Error("late"));
    expect(received).toEqual([{ data: [], error: undefined }]);
    expect(unsubscribed).toBe(1);
  });
});
