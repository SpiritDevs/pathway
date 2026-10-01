// @effect-diagnostics globalDate:off -- Fake clock drives lease deadlines; worker receipts coordinate assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CompanyId } from "@spiritdevs/contracts/company";
import { AppStoreReleaseClient } from "@spiritdevs/backend/appStoreReleaseApi";
import { awaitReleaseCloud, ReleaseAccess } from "./ReleaseAccess.ts";
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
  it("bounds a stalled Cloud call even before a credential lease exists", async () => {
    const entered = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<void>();
    const waiting = awaitReleaseCloud(new AbortController().signal, () => {
      entered.resolve();
      return stalled.promise;
    });
    const rejected = expect(waiting).rejects.toMatchObject({ code: "cloud-unavailable" });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    stalled.resolve();
    await stalled.promise;
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    "initial-authorize",
    "initial-heartbeat",
    "credential",
    "write-authorize",
    "write-approval",
    "final-authorize",
    "final-heartbeat",
  ])("cancellation interrupts stalled %s and ignores its late reply", async (stage) => {
    const entered = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<void>();
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
    const wait = async (at: string) => {
      if (stage === at) {
        entered.resolve();
        await stalled.promise;
      }
    };
    let authorizations = 0;
    let heartbeats = 0;
    const backend: AppleBackend = {
      authorizeCaller: async () => {
        await wait(
          ++authorizations === 1
            ? "initial-authorize"
            : stage.startsWith("write-")
              ? "write-authorize"
              : "final-authorize",
        );
        return null;
      },
      accountStatus: async () => null,
      heartbeat: async () => {
        await wait(++heartbeats === 1 ? "initial-heartbeat" : "final-heartbeat");
        return { integration, expiresAt: Date.now() + 30_000 };
      },
      credential: async () => {
        await wait("credential");
        return appleTestCredential;
      },
      status: async () => ({ integration, environments: [] }),
      health: async () => null,
    };
    const http = vi.fn(async () => Response.json({ data: { id: "upload" } }));
    const access = new ReleaseAccess(
      backend,
      (credential, signal, check) =>
        new AppStoreReleaseClient(credential, http, Date.now, signal, check),
    );
    const controller = new AbortController();
    const work = vi.fn(async (client: AppStoreReleaseClient) => {
      if (stage.startsWith("write-"))
        await client.upload(
          target.appId,
          {
            kind: "upload",
            archiveId: "archive",
            artifactSha256: "sha",
            version: "1.0",
            buildNumber: "1",
            platform: "IOS",
          },
          { name: "App.ipa", size: 1, slice: () => new Blob(["x"]) },
          () => {},
          async () => {},
        );
    });
    const running = access.run(
      target,
      caller,
      true,
      controller.signal,
      () => wait("write-approval"),
      work,
    );
    const rejected = expect(running).rejects.toBeDefined();
    await entered.promise;
    controller.abort();
    await rejected;
    const workCalls = work.mock.calls.length;
    stalled.resolve();
    await stalled.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(work).toHaveBeenCalledTimes(workCalls);
    expect(http).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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
