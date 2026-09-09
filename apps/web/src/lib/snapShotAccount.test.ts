import { expect, it, vi } from "vite-plus/test";
import type { DesktopSnapShotBridge } from "./desktopSnapShot";
import { bindSnapShotAccount } from "./snapShotAccount";

it("waits for native account synchronization before enabling delivery", async () => {
  let finish!: () => void;
  const persisted = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const bridge = {
    setSnapShotAccount: vi.fn(async () => persisted),
  } as unknown as DesktopSnapShotBridge;
  const account = bindSnapShotAccount(bridge, "account-a");
  expect(account.isCurrent()).toBe(false);
  finish();
  await account.ready;
  expect(account.isCurrent()).toBe(true);
  await account.release();
  expect(account.isCurrent()).toBe(false);
});

it("invalidates the previous account immediately and preserves the newer binding on old cleanup", async () => {
  const setSnapShotAccount = vi.fn(async () => undefined);
  const bridge = { setSnapShotAccount } as unknown as DesktopSnapShotBridge;
  const first = bindSnapShotAccount(bridge, "account-a");
  await first.ready;
  const second = bindSnapShotAccount(bridge, "account-b");
  expect(first.isCurrent()).toBe(false);
  expect(second.isCurrent()).toBe(false);
  await first.release();
  await second.ready;
  expect(second.isCurrent()).toBe(true);
  expect(setSnapShotAccount.mock.calls).toEqual([["account-a"], ["account-b"]]);
  await second.release();
  expect(second.isCurrent()).toBe(false);
  expect(setSnapShotAccount).toHaveBeenLastCalledWith(null);
});
