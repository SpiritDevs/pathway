import { it as effectIt } from "@effect/vitest";
// @effect-diagnostics globalDate:off -- Fake timers test snapshot cadence; workers are awaited through drain receipts.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { XcodeJob, XcodeStepId, XcodeStatus } from "@spiritdevs/contracts/xcode";
import { AuthOrchestrationReadScope, AuthOrchestrationOperateScope } from "@spiritdevs/contracts";
import { AppleError } from "@spiritdevs/contracts/apple";
import { CompanyId } from "@spiritdevs/contracts/company";
import { XcodeInstall, xcodeError, type XcodeHost, type XcodeJobStore } from "./XcodeInstall.ts";
import { makeXcodeRpcHandlers } from "./xcodeRpc.ts";
const target = {
  accountId: "apple",
  companyId: CompanyId.make("01990000-0000-7000-8000-000000000011"),
};
const receipt = <A>() => {
  let resolve!: (a: A) => void;
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
function harness(options: { admin?: boolean; supported?: boolean } = {}) {
  let saved: XcodeJob | null = null;
  const store: XcodeJobStore = {
    load: async () => saved,
    save: vi.fn(async (job) => {
      saved = structuredClone(job);
    }),
  };
  const calls: XcodeStepId[] = [];
  const host: XcodeHost = {
    supported: options.supported ?? true,
    inspect: async () => ({
      host: options.supported === false ? "needs-mac" : "mac",
      installed: [],
      available: [],
      runtimes: [],
      disk: { freeBytes: 100e9, requiredBytes: 45e9 },
      error: null,
    }),
    installPath: async () => "/Applications/Xcode-27.app",
    needsAdmin: (step) =>
      (options.admin ?? false) &&
      ["move", "license", "select", "first-launch", "helpers"].includes(step),
    run: vi.fn(async (step) => {
      calls.push(step);
    }),
  };
  const runtime = new XcodeInstall(host, store);
  return { host, store, runtime, calls, saved: () => saved };
}
afterEach(() => vi.useRealTimers());
describe("durable Xcode jobs", () => {
  it("runs all requested steps in order and requires explicit admin approval each time", async () => {
    const h = harness({ admin: true });
    const job = await h.runtime.install(target, "27A1", ["iOS", "watchOS", "tvOS"]);
    await h.runtime.drained();
    expect(h.calls).toEqual(["check", "download", "expand"]);
    expect((await h.runtime.status()).job?.state).toBe("needs-admin");
    for (const id of ["move", "license", "select", "first-launch", "helpers"]) {
      expect((await h.runtime.status()).job?.steps.find((s) => s.state === "needs-admin")?.id).toBe(
        id,
      );
      await h.runtime.approve(target, job.id);
      await h.runtime.drained();
    }
    expect((await h.runtime.status()).job?.state).toBe("completed");
    expect(h.calls).toEqual([
      "check",
      "download",
      "expand",
      "move",
      "license",
      "select",
      "first-launch",
      "runtimes",
      "helpers",
    ]);
    expect(h.saved()?.state).toBe("completed");
    await h.runtime.dispose();
  });
  for (const restart of [false, true]) {
    effectIt.effect(
      `reclaims a deleted account's paused job${restart ? " after restart" : " before a new job"}`,
      () =>
        Effect.gen(function* () {
          const h = harness({ admin: true });
          let available = true;
          const accountAvailable = async (account: { accountId: string }) =>
            account.accountId !== target.accountId || available;
          let runtime = new XcodeInstall(h.host, h.store, undefined, accountAvailable);
          const apple = {
            authorizeCaller: async (account: { accountId: string }) => {
              if (!(await accountAvailable(account)))
                throw new AppleError({
                  code: "forbidden",
                  message: "Account removed",
                  retryAfterSeconds: null,
                });
            },
          };
          const handlers = () =>
            makeXcodeRpcHandlers(
              runtime,
              apple,
              [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
              Effect.succeed({ clerkSubject: "owner" }),
            );
          const job = yield* handlers()["xcode.select"]({
            ...target,
            path: "/Applications/Xcode.app",
          });
          yield* Effect.promise(() => runtime.drained());
          expect(h.saved()?.state).toBe("needs-admin");
          expect(
            yield* Effect.result(
              handlers()["xcode.select"]({
                ...target,
                accountId: "available-account",
                path: "/Applications/Xcode.app",
              }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { code: "busy" } });
          expect(h.saved()?.state).toBe("needs-admin");
          available = false;
          expect(
            yield* Effect.result(handlers()["xcode.cancel"]({ ...target, jobId: job.id })),
          ).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } });
          if (restart) {
            yield* Effect.promise(() => runtime.dispose());
            runtime = new XcodeInstall(h.host, h.store, undefined, accountAvailable);
          }
          const other = { ...target, accountId: "available-account" };
          const writes = vi.mocked(h.store.save);
          if (restart) {
            expect((yield* handlers()["xcode.status"](other)).job).toBeNull();
            expect(h.saved()).toMatchObject({ id: job.id, state: "cancelled" });
          }
          const next = yield* handlers()["xcode.select"]({
            ...other,
            path: "/Applications/Xcode.app",
          });
          expect(next.account).toEqual(other);
          expect(writes.mock.calls.map(([value]) => value)).toContainEqual(
            expect.objectContaining({
              id: job.id,
              state: "cancelled",
              steps: expect.arrayContaining([
                expect.objectContaining({
                  id: "select",
                  state: "cancelled",
                  error: {
                    code: "cancelled",
                    message:
                      "The Apple account was removed or this environment no longer has access. Start a new Xcode job with an available account.",
                  },
                }),
              ]),
            }),
          );
          yield* Effect.promise(() => runtime.drained());
          yield* Effect.promise(() => runtime.dispose());
          yield* Effect.promise(() => h.runtime.dispose());
        }),
    );
  }
  it("waits for an orphaned running worker to exit before starting another account's job", async () => {
    const h = harness();
    const entered = receipt<void>();
    const aborted = receipt<void>();
    const release = receipt<void>();
    let available = true;
    const runtime = new XcodeInstall(
      h.host,
      h.store,
      undefined,
      async (account) => account.accountId !== target.accountId || available,
    );
    h.host.run = async (step, _job, signal) => {
      h.calls.push(step);
      if (step === "download") {
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await release.promise;
      }
    };
    const original = await runtime.install(target, "27A1", []);
    await entered.promise;
    available = false;
    const next = runtime.select(
      { ...target, accountId: "available-account" },
      "/Applications/Xcode.app",
    );
    await aborted.promise;
    expect(h.saved()).toMatchObject({ id: original.id, state: "cancelling" });
    expect(h.calls).not.toContain("select");
    release.resolve();
    expect((await next).account.accountId).toBe("available-account");
    await runtime.drained();
    expect(h.calls).not.toContain("expand");
    expect(vi.mocked(h.store.save).mock.calls.map(([job]) => job)).toContainEqual(
      expect.objectContaining({ id: original.id, state: "cancelled" }),
    );
    await runtime.dispose();
    await h.runtime.dispose();
  });
  it("preserves a paused job when its account check has a transient failure", async () => {
    const h = harness({ admin: true });
    let failure = false;
    const runtime = new XcodeInstall(h.host, h.store, undefined, async () => {
      if (failure) throw new Error("Cloud unavailable");
      return true;
    });
    const job = await runtime.select(target, "/Applications/Xcode.app");
    await runtime.drained();
    failure = true;
    await expect(
      runtime.select({ ...target, accountId: "another" }, "/Applications/Xcode.app"),
    ).rejects.toThrow("Cloud unavailable");
    expect(h.saved()).toMatchObject({ id: job.id, state: "needs-admin" });
    await runtime.dispose();
    await h.runtime.dispose();
  });
  it("fails before downloading when disk space is insufficient, then retries", async () => {
    const h = harness();
    let diskLow = true;
    h.host.run = vi.fn(async (step) => {
      if (step === "check" && diskLow) throw xcodeError("disk-space", "Free space on the Mac.");
      h.calls.push(step);
    });
    const job = await h.runtime.install(target, "27A1", []);
    await h.runtime.drained();
    expect(h.calls).toEqual([]);
    expect(h.saved()?.steps[0]).toMatchObject({ state: "failed", error: { code: "disk-space" } });
    diskLow = false;
    await h.runtime.retry(target, job.id);
    await h.runtime.drained();
    expect(h.saved()?.state).toBe("completed");
    await h.runtime.dispose();
  });
  it("offers retry after restart and retains completed steps without rerunning downloads", async () => {
    const h = harness();
    const failed = receipt<void>();
    h.host.run = async (step) => {
      h.calls.push(step);
      if (step === "expand") {
        failed.resolve();
        throw xcodeError("process-failed", "expand failed");
      }
    };
    const job = await h.runtime.install(target, "27A1", []);
    await failed.promise;
    await h.runtime.drained();
    const saved = h.saved()!;
    await h.store.save({
      ...saved,
      state: "running",
      steps: saved.steps.map((s) => (s.id === "expand" ? { ...s, state: "running" } : s)),
    });
    await h.runtime.dispose();
    h.calls.length = 0;
    h.host.run = async (step) => {
      h.calls.push(step);
    };
    const restarted = new XcodeInstall(h.host, h.store);
    expect((await restarted.status()).job?.state).toBe("interrupted");
    await restarted.retry(target, job.id);
    await restarted.drained();
    expect(h.calls).not.toContain("download");
    expect(h.calls[0]).toBe("expand");
    expect(h.saved()?.state).toBe("completed");
    await restarted.dispose();
  });
  it("cancels the host worker, rejects concurrent jobs, and ignores late progress", async () => {
    const h = harness();
    const entered = receipt<void>();
    const exited = receipt<void>();
    const release = receipt<void>();
    h.host.run = async (step, _job, signal, progress) => {
      h.calls.push(step);
      if (step !== "download") return;
      signal.addEventListener("abort", () => exited.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      progress({ bytes: 100, total: 100, bytesPerSecond: 100 });
    };
    const job = await h.runtime.install(target, "27A1", []);
    await entered.promise;
    await expect(h.runtime.select(target, "/Applications/Xcode.app")).rejects.toMatchObject({
      code: "busy",
    });
    expect((await h.runtime.cancel(target, job.id)).state).toBe("cancelling");
    await exited.promise;
    await expect(h.runtime.retry(target, job.id)).rejects.toMatchObject({ code: "busy" });
    release.resolve();
    await h.runtime.drained();
    expect(h.saved()?.state).toBe("cancelled");
    expect(h.calls).not.toContain("expand");
    expect(h.saved()?.steps.find((s) => s.id === "download")?.progress).toBeNull();
    await h.runtime.dispose();
  });
  it("uses at most three coalesced snapshots per second even for rapid progress", async () => {
    vi.useFakeTimers();
    const h = harness();
    const entered = receipt<void>();
    const release = receipt<void>();
    const received: XcodeStatus[] = [];
    h.runtime.watch((state) => received.push(state));
    h.host.run = async (step, _job, _signal, progress) => {
      if (step === "download") {
        for (let bytes = 0; bytes < 1000; bytes++)
          progress({ bytes, total: 1000, bytesPerSecond: 100 });
        entered.resolve();
        await release.promise;
      }
    };
    await h.runtime.install(target, "27A1", []);
    await entered.promise;
    expect(received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(350);
    expect(received).toHaveLength(1);
    expect(received[0]?.job?.steps.find((s) => s.id === "download")?.progress?.bytes).toBe(999);
    release.resolve();
    await h.runtime.drained();
    await vi.advanceTimersByTimeAsync(350);
    expect(received).toHaveLength(2);
    await h.runtime.dispose();
  });
  it("reports needs a Mac and performs no install work on other hosts", async () => {
    const h = harness({ supported: false });
    expect((await h.runtime.status()).host).toBe("needs-mac");
    await expect(h.runtime.install(target, "27A1", [])).rejects.toMatchObject({
      code: "needs-mac",
    });
    await expect(h.runtime.select(target, "/Applications/Xcode.app")).rejects.toMatchObject({
      code: "needs-mac",
    });
    expect(h.host.run).not.toHaveBeenCalled();
    expect(h.store.save).not.toHaveBeenCalled();
    await h.runtime.dispose();
  });
  effectIt.effect(
    "read-only sockets cannot install, approve, cancel, retry, select, or install runtimes",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const rpc = makeXcodeRpcHandlers(h.runtime, { authorizeCaller: async () => null }, [
          AuthOrchestrationReadScope,
        ]);
        const effects = [
          rpc["xcode.install"]({ ...target, versionId: "27A1", platforms: [] }),
          rpc["xcode.select"]({ ...target, path: "x" }),
          rpc["xcode.installRuntimes"]({ ...target, path: "x", platforms: [] }),
          ...["xcode.approve", "xcode.cancel", "xcode.retry"].map((method) =>
            rpc[method as "xcode.cancel"]({ ...target, jobId: "job" }),
          ),
        ];
        for (const effect of effects)
          expect(yield* Effect.result(effect)).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "EnvironmentAuthorizationError" },
          });
        expect(h.store.save).not.toHaveBeenCalled();
        yield* Effect.promise(() => h.runtime.dispose());
      }),
  );
  it("stops before host mutations when persisting a step fails", async () => {
    const h = harness();
    const save = h.store.save;
    let writes = 0;
    h.store.save = async (job) => {
      if (++writes === 2) throw new Error("disk error SECRET");
      await save(job);
    };
    await h.runtime.install(target, "27A1", []);
    await h.runtime.drained();
    expect(h.calls).toEqual([]);
    const state = await h.runtime.status();
    expect(state.job?.state).toBe("failed");
    expect(JSON.stringify(state)).not.toContain("SECRET");
    await h.runtime.dispose();
  });
});
