// @effect-diagnostics globalDate:off -- Fake clock drives lease deadlines; worker receipts coordinate assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CompanyId } from "@spiritdevs/contracts/company";
import { AppStoreReleaseClient } from "@spiritdevs/backend/appStoreReleaseApi";
import { ReleaseAccess } from "./ReleaseAccess.ts";
import type { AppleBackend } from "../apple/AppleRuntime.ts";
import { appleTestCredential } from "../../../../packages/backend/src/fixtures/appleTestKey.ts";
const target = {
  companyId: CompanyId.make("01990000-0000-7000-8000-000000000011"),
  accountId: "account",
  teamId: "APPLETEAM1",
  appId: "app",
};
const caller = { clerkSubject: "owner" };
describe("Active release credential leases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it.each(["rotation", "scope-change", "revoked", "cloud-outage"])(
    "aborts active work after %s",
    async (scenario) => {
      const integration = {
        accountId: target.accountId,
        teamId: target.teamId,
        accountRevision: 1,
        revision: 1,
        connected: true,
        issuerId: "issuer",
        keyIdSuffix: "KEY1",
        lastVerifiedAt: null,
      };
      let fail = false;
      const backend: AppleBackend = {
        authorizeCaller: async () => null,
        accountStatus: async () => null,
        heartbeat: async () => {
          if (fail) throw new Error("private transport response");
          return { integration: { ...integration }, expiresAt: Date.now() + 30_000 };
        },
        credential: async () => appleTestCredential,
        status: async () => ({ integration, environments: [] }),
        health: async () => null,
      };
      const access = new ReleaseAccess(
        backend,
        (credential, signal, check) =>
          new AppStoreReleaseClient(
            credential,
            async () => {
              throw new Error("No HTTP expected");
            },
            Date.now,
            signal,
            check,
          ),
      );
      const entered = Promise.withResolvers<void>();
      const work = access.run(
        target,
        caller,
        true,
        new AbortController().signal,
        async () => {},
        async (_client, _credential, signal) => {
          entered.resolve();
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      );
      const rejected = expect(work).rejects.toBeDefined();
      await entered.promise;
      if (scenario === "rotation") integration.revision++;
      if (scenario === "scope-change") integration.accountRevision++;
      if (scenario === "revoked") integration.connected = false;
      if (scenario === "cloud-outage") fail = true;
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("the hard expiry aborts work even when Cloud renewal never responds", async () => {
    const integration = {
      accountId: target.accountId,
      teamId: target.teamId,
      accountRevision: 1,
      revision: 1,
      connected: true,
      issuerId: "issuer",
      keyIdSuffix: "KEY1",
      lastVerifiedAt: null,
    };
    const stalled = Promise.withResolvers<{ integration: typeof integration; expiresAt: number }>();
    let calls = 0;
    const backend: AppleBackend = {
      authorizeCaller: async () => null,
      accountStatus: async () => null,
      heartbeat: async () =>
        ++calls === 1 ? { integration, expiresAt: Date.now() + 30_000 } : stalled.promise,
      credential: async () => appleTestCredential,
      status: async () => ({ integration, environments: [] }),
      health: async () => null,
    };
    const access = new ReleaseAccess(backend);
    const entered = Promise.withResolvers<void>();
    const work = access.run(
      target,
      caller,
      true,
      new AbortController().signal,
      async () => {},
      async (_client, _credential, signal) => {
        entered.resolve();
        return new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      },
    );
    const rejected = expect(work).rejects.toMatchObject({ code: "credential-changed" });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    stalled.resolve({ integration, expiresAt: Date.now() + 30_000 });
    await stalled.promise;
    expect(vi.getTimerCount()).toBe(0);
  });
});
