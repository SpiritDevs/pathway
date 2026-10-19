import { describe, expect, it } from "vite-plus/test";
import type { AlertPolicyRow } from "@spiritdevs/contracts/threadAlerts";
import { createOptimisticAlertPolicies } from "./optimisticPolicy";

function deferred() {
  let resolve!: (value: null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<null>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const row = (completion: boolean): AlertPolicyRow => ({
  scopeKind: "thread",
  scopeKey: "thread",
  choices: { completion },
});

describe("optimistic alert policy", () => {
  it("holds a completed write across stale replicas until the scope matches", async () => {
    let visible: readonly AlertPolicyRow[] = [];
    const state = createOptimisticAlertPolicies((rows) => {
      visible = rows;
    });
    state.receive([row(false)]);
    await state.write(row(true), async () => null);
    state.receive([row(false)]);
    expect(visible).toEqual([row(true)]);
    state.receive([row(true)]);
    state.receive([row(false)]);
    expect(visible).toEqual([row(false)]);
  });
  it("an old failure cannot undo the newer toggle", async () => {
    let visible: readonly AlertPolicyRow[] = [];
    const state = createOptimisticAlertPolicies((rows) => {
      visible = rows;
    });
    const first = deferred();
    const old = state.write(row(true), () => first.promise).catch(() => null);
    await state.write(row(false), async () => null);
    first.reject(new Error("old write failed"));
    await old;
    expect(visible).toEqual([row(false)]);
  });
  it("a failed latest write restores the preceding in-flight choice", async () => {
    let visible: readonly AlertPolicyRow[] = [];
    const state = createOptimisticAlertPolicies((rows) => {
      visible = rows;
    });
    const first = deferred();
    const pending = state.write(row(true), () => first.promise);
    await expect(
      state.write(row(false), async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(visible).toEqual([row(true)]);
    first.resolve(null);
    await pending;
    state.receive([row(false)]);
    expect(visible).toEqual([row(true)]);
  });
  it("holds reset until the deleted override disappears", async () => {
    let visible: readonly AlertPolicyRow[] = [];
    const state = createOptimisticAlertPolicies((rows) => {
      visible = rows;
    });
    state.receive([row(true)]);
    await state.write({ ...row(true), choices: {} }, async () => null);
    state.receive([row(true)]);
    expect(visible).toEqual([]);
    state.receive([]);
    state.receive([row(false)]);
    expect(visible).toEqual([row(false)]);
  });
});
