// @effect-diagnostics globalDate:off -- Tests inject Cloud, Xcode and ASC HTTP, and drain workers without sleeps.
import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { CompanyId } from "@spiritdevs/contracts/company";
import { ReleaseRpcs, type ReleaseIntent } from "@spiritdevs/contracts/releases";
import { AppStoreReleaseClient } from "@spiritdevs/backend/appStoreReleaseApi";
import { appleFailure, type AscHttp } from "@spiritdevs/backend/appStoreConnectApi";
import { appleTestCredential } from "../../../../packages/backend/src/fixtures/appleTestKey.ts";
import { ReleaseRuntime, type ReleaseBackend } from "./ReleaseRuntime.ts";
import { ReleaseAccess } from "./ReleaseAccess.ts";
import { releaseError, type ReleaseHost } from "./ReleaseHost.ts";
import type { ReleaseState, ReleaseStore } from "./ReleaseStore.ts";
import type { AppleBackend } from "../apple/AppleRuntime.ts";
import { makeReleaseRpcHandlers } from "./releaseRpc.ts";
const target = {
  companyId: CompanyId.make("01990000-0000-7000-8000-000000000011"),
  accountId: "account",
  teamId: "APPLETEAM1",
  appId: "app",
};
const caller = { clerkSubject: "owner" };
const archiveInput = {
  ...target,
  projectPath: "/project/App.xcodeproj",
  scheme: "App",
  version: "1.2",
  platform: "IOS" as const,
};
function harness() {
  let state: ReleaseState = { jobs: [], archives: [] };
  let approved = false;
  let intent: ReleaseIntent | undefined;
  const store: ReleaseStore = {
    load: async () => state,
    save: async (next) => {
      state = structuredClone(next);
    },
  };
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
  const backend: AppleBackend = {
    authorizeCaller: vi.fn(async () => null),
    accountStatus: async () => null,
    heartbeat: vi.fn(async () => ({
      integration: { ...integration },
      expiresAt: Date.now() + 30_000,
    })),
    credential: async () => appleTestCredential,
    status: async () => ({ integration, environments: [] }),
    health: async () => null,
  };
  const http = vi.fn<AscHttp>(async (url, init) => {
    if (init.method !== "GET") {
      if (url.endsWith("/buildUploads")) return Response.json({ data: { id: "upload" } });
      if (url.endsWith("/buildUploadFiles"))
        return Response.json({
          data: {
            id: "file",
            attributes: {
              uploadOperations: [
                {
                  method: "PUT",
                  url: "https://upload.apple.com/part",
                  offset: 0,
                  length: 3,
                  requestHeaders: [],
                },
              ],
            },
          },
        });
      return new Response(null, { status: 204 });
    }
    if (url.includes("/apps?"))
      return Response.json({
        data: [{ id: "app", attributes: { name: "App", bundleId: "com.example.app" } }],
      });
    return Response.json({ data: [] });
  });
  const access = new ReleaseAccess(
    backend,
    (credential, signal, check) =>
      new AppStoreReleaseClient(credential, http, Date.now, signal, check),
  );
  const host: ReleaseHost = {
    recover: vi.fn(async () => {}),
    archive: vi.fn(async () => ({
      archivePath: "/archive",
      artifactPath: "/artifact",
      artifactSha256: "sha",
      artifactBytes: 3,
    })),
    source: vi.fn(async () => ({ name: "App.ipa", size: 3, slice: () => new Blob(["abc"]) })),
  };
  const cloud: ReleaseBackend = {
    prepare: async (_target, _caller, action) =>
      (intent = {
        id: "intent",
        target,
        environmentId: "env",
        state: "pending",
        expiresAt: Date.now() + 900_000,
        action,
      }),
    consume: vi.fn(async () => {
      if (!approved || !intent || intent.state !== "approved")
        throw releaseError("confirmation-required", "Confirm in the client.");
      intent = { ...intent, state: "consumed" };
      return intent;
    }),
    checkExecution: vi.fn(async () => {
      if (!approved) throw releaseError("publishing-disabled", "Publishing disabled.");
    }),
    acquireBuildLease: vi.fn(async () => ({ token: "lease", expiresAt: Date.now() + 30_000 })),
    allocateBuildNumber: vi.fn(async () => "42"),
  };
  const make = () =>
    new ReleaseRuntime({
      host,
      store,
      access,
      cloud,
      environment: { id: "env", label: "Build Mac" },
    });
  const runtime = make();
  return {
    runtime,
    make,
    host,
    backend,
    integration,
    cloud,
    http,
    state: () => state,
    seed: (next: ReleaseState) => {
      state = next;
    },
    approve: () => {
      approved = true;
      intent = { ...intent!, state: "approved" };
    },
    revoke: () => {
      approved = false;
    },
  };
}
describe("Release jobs and RPCs", () => {
  it("disposes while the pre-worker approval consumption is stalled", async () => {
    const h = harness();
    const entered = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<ReleaseIntent>();
    h.cloud.consume = async () => {
      entered.resolve();
      return stalled.promise;
    };
    const executing = h.runtime.execute(target, caller, "intent");
    const rejected = expect(executing).rejects.toBeDefined();
    await entered.promise;
    await h.runtime.dispose();
    await rejected;
    stalled.resolve({
      id: "intent",
      target,
      environmentId: "env",
      state: "consumed",
      expiresAt: Date.now() + 30_000,
      action: { kind: "app-store", buildId: "build", versionId: "version" },
    });
    await stalled.promise;
    expect(h.state().jobs).toHaveLength(0);
    expect(h.http).not.toHaveBeenCalled();
  });
  it.each(["cancel", "dispose"] as const)(
    "%s drains a worker stalled before an Apple write",
    async (method) => {
      const h = harness();
      const entered = Promise.withResolvers<void>();
      const stalled = Promise.withResolvers<void>();
      let checks = 0;
      h.cloud.checkExecution = async () => {
        if (++checks === 2) {
          entered.resolve();
          await stalled.promise;
        }
      };
      await h.runtime.archive(archiveInput, caller);
      await h.runtime.drain();
      const archive = h.state().archives[0]!;
      const intent = await h.runtime.prepare(target, caller, {
        kind: "upload",
        archiveId: archive.id,
        artifactSha256: archive.artifactSha256,
        version: archive.version,
        buildNumber: archive.buildNumber,
        platform: archive.platform,
      });
      h.approve();
      const job = await h.runtime.execute(target, caller, intent.id);
      await entered.promise;
      if (method === "cancel") await h.runtime.cancel(target, job.id);
      else await h.runtime.dispose();
      expect(h.state().jobs.at(-1)?.state).toBe("cancelled");
      stalled.resolve();
      await stalled.promise;
      await h.runtime.dispose();
      expect(h.http.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
    },
  );
  effectIt.effect("retains Organizer refresh while coalescing local progress events", () =>
    Effect.gen(function* () {
      const h = harness();
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const initialOrganizer = Promise.withResolvers<void>();
      let listener: ((kind: "local" | "organizer") => void) | undefined;
      let localCalls = 0;
      let organizerCalls = 0;
      h.runtime.watch = (_target, onChange) => {
        listener = onChange;
        return () => {
          listener = undefined;
        };
      };
      h.runtime.localStatus = async () => {
        if (++localCalls === 2) {
          entered.resolve();
          await gate.promise;
        }
        return { environmentId: "env", environmentLabel: "Test", archives: [], jobs: [] };
      };
      h.runtime.organizer = async () => {
        organizerCalls++;
        initialOrganizer.resolve();
        return { builds: [], groups: [], testers: [], versions: [], reviews: [], fetchedAt: 0 };
      };
      const handlers = makeReleaseRpcHandlers(
        h.runtime,
        { authorizeCaller: async () => null },
        ["orchestration:read"],
        Effect.succeed(caller),
      );
      const fiber = yield* Effect.forkChild(
        handlers["releases.subscribe"](target).pipe(Stream.take(5), Stream.runCollect),
      );
      yield* Effect.promise(() => initialOrganizer.promise);
      listener!("local");
      yield* Effect.promise(() => entered.promise);
      listener!("organizer");
      listener!("local");
      listener!("local");
      gate.resolve();
      const updates = yield* Fiber.join(fiber);
      expect([...updates].map((update) => update.kind)).toEqual([
        "local",
        "organizer",
        "local",
        "organizer",
        "local",
      ]);
      expect(organizerCalls).toBe(2);
      expect(listener).toBeUndefined();
      yield* Effect.promise(() => h.runtime.dispose());
    }),
  );
  it("archives with a centrally allocated number, then requires client approval to upload", async () => {
    const h = harness();
    const job = await h.runtime.archive(archiveInput, caller);
    await h.runtime.drain();
    const status = await h.runtime.localStatus(target);
    expect(status.jobs[0]).toMatchObject({ id: job.id, state: "completed" });
    const archive = status.archives[0]!;
    expect(archive).toMatchObject({
      environmentId: "env",
      environmentLabel: "Build Mac",
      buildNumber: "42",
    });
    expect(h.host.archive).toHaveBeenCalledWith(
      archiveInput,
      job.id,
      "42",
      "com.example.app",
      appleTestCredential,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    const action = {
      kind: "upload" as const,
      archiveId: archive.id,
      artifactSha256: archive.artifactSha256,
      buildNumber: archive.buildNumber,
      version: archive.version,
      platform: archive.platform,
    };
    await expect(
      h.runtime.prepare(target, caller, { ...action, buildNumber: "43" }),
    ).rejects.toMatchObject({ code: "artifact-changed" });
    const intent = await h.runtime.prepare(target, caller, action);
    await expect(h.runtime.execute(target, caller, intent.id)).rejects.toMatchObject({
      code: "confirmation-required",
    });
    expect(h.http.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
    h.approve();
    await h.runtime.execute(target, caller, intent.id);
    await h.runtime.drain();
    expect(h.state().jobs.at(-1)).toMatchObject({
      state: "completed",
      phase: "uploaded-awaiting-processing",
      resourceId: "upload",
      progress: { bytes: 3, total: 3 },
    });
    await expect(h.runtime.execute(target, caller, intent.id)).rejects.toMatchObject({
      code: "confirmation-required",
    });
    expect(h.cloud.checkExecution).toHaveBeenCalled();
    await h.runtime.dispose();
  });
  it("fetches only while a view watches, caches briefly, and evicts on unsubscribe", async () => {
    const h = harness();
    await h.runtime.localStatus(target);
    h.runtime.refresh(target);
    expect(h.http).not.toHaveBeenCalled();
    await expect(
      h.runtime.organizer(target, caller, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-input" });
    const unwatch = h.runtime.watch(target, () => {});
    await h.runtime.organizer(target, caller, new AbortController().signal);
    const reads = h.http.mock.calls.length;
    await h.runtime.organizer(target, caller, new AbortController().signal);
    expect(h.http).toHaveBeenCalledTimes(reads);
    h.runtime.refresh(target);
    await h.runtime.organizer(target, caller, new AbortController().signal);
    expect(h.http).toHaveBeenCalledTimes(reads * 2);
    unwatch();
    expect(h.http).toHaveBeenCalledTimes(reads * 2);
    const again = h.runtime.watch(target, () => {});
    await h.runtime.organizer(target, caller, new AbortController().signal);
    expect(h.http).toHaveBeenCalledTimes(reads * 3);
    again();
    await h.runtime.dispose();
  });
  it("drains cancellation and keeps another app's jobs and archives private", async () => {
    const h = harness();
    const entered = Promise.withResolvers<void>();
    h.host.archive = async (_input, _id, _number, _bundle, _credential, signal) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    };
    const job = await h.runtime.archive(archiveInput, caller);
    await entered.promise;
    await expect(h.runtime.archive(archiveInput, caller)).rejects.toMatchObject({ code: "busy" });
    await expect(h.runtime.cancel({ ...target, appId: "other" }, job.id)).rejects.toMatchObject({
      code: "not-found",
    });
    expect((await h.runtime.localStatus({ ...target, appId: "other" })).jobs).toEqual([]);
    expect((await h.runtime.cancel(target, job.id)).state).toBe("cancelled");
    await h.runtime.drain();
    await h.runtime.dispose();
  });
  it("marks persisted running jobs interrupted without replaying Apple writes", async () => {
    const h = harness();
    await h.runtime.archive(archiveInput, caller);
    await h.runtime.drain();
    await h.runtime.dispose();
    h.seed({ ...h.state(), jobs: h.state().jobs.map((j) => ({ ...j, state: "running" })) });
    h.http.mockClear();
    const restarted = h.make();
    expect((await restarted.localStatus(target)).jobs[0]?.state).toBe("interrupted");
    expect(h.http).not.toHaveBeenCalled();
    await restarted.dispose();
  });
  effectIt.effect(
    "enforces scopes and caller identity, and exposes no confirmation RPC to agents",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const readonly = makeReleaseRpcHandlers(
          h.runtime,
          h.backend,
          ["orchestration:read"],
          Effect.succeed(caller),
        );
        expect(yield* Effect.flip(readonly["releases.archive"](archiveInput))).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredScope: "orchestration:operate",
        });
        const anonymous = makeReleaseRpcHandlers(h.runtime, h.backend, ["orchestration:read"]);
        expect(yield* Effect.flip(anonymous["releases.localStatus"](target))).toMatchObject({
          code: "forbidden",
        });
        expect([...ReleaseRpcs.requests.keys()].some((name) => /confirm|enable/iu.test(name))).toBe(
          false,
        );
        const updates = yield* Stream.runCollect(
          readonly["releases.subscribe"](target).pipe(Stream.take(2)),
        );
        expect([...updates].map((u) => u.kind)).toEqual(["local", "organizer"]);
        yield* Effect.promise(() =>
          expect(
            h.runtime.organizer(target, caller, new AbortController().signal),
          ).rejects.toMatchObject({ code: "invalid-input" }),
        );
        h.backend.authorizeCaller = async () => {
          throw appleFailure("forbidden", "Revoked");
        };
        const revoked = makeReleaseRpcHandlers(
          h.runtime,
          h.backend,
          ["orchestration:read"],
          Effect.succeed(caller),
        );
        expect(yield* Effect.flip(revoked["releases.localStatus"](target))).toMatchObject({
          code: "forbidden",
          message: "Revoked",
        });
        yield* Effect.promise(() => h.runtime.dispose());
      }),
  );
});
