import { it as effectIt } from "@effect/vitest";
// @effect-diagnostics globalDate:off -- Fake clock and controlled protocol receipts.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { AppleIdSession } from "./AppleIdSession.ts";
import { AppleRuntime } from "./AppleRuntime.ts";
import { makeAppleRpcHandlers } from "./appleRpc.ts";
import type { AppleIdProtocol, AppleAuthenticated } from "./AppleIdProtocol.ts";
import type { AppleSessionBackend, AppleSessionMetadata } from "@spiritdevs/backend/appleSession";
import { AppleError, type AppleIdSessionState } from "@spiritdevs/contracts/apple";
import type { AppleBackend } from "./AppleRuntime.ts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { AuthOrchestrationReadScope, AuthOrchestrationOperateScope } from "@spiritdevs/contracts";
const target = {
  accountId: "apple-1",
  companyId: CompanyId.make("01990000-0000-7000-8000-000000000011"),
};
const receipt = <A>() => {
  let resolve!: (a: A) => void;
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
const NOW = 1_800_000_000_000;
const authenticated: AppleAuthenticated = {
  credential: {
    cookies: [
      {
        key: "myacinfo",
        value: "SECRET-COOKIE",
        domain: ".apple.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expires: null,
      },
    ],
  },
  expiresAt: NOW + 60_000,
  teams: [],
};
function harness() {
  let metadata: AppleSessionMetadata = {
    email: "owner@apple.test",
    accountRevision: 1,
    revision: 0,
    expiresAt: null,
  };
  const backend: AppleSessionBackend = {
    status: vi.fn(async () => metadata),
    save: vi.fn(async (_target, input) => {
      metadata = { ...metadata, revision: metadata.revision + 1, expiresAt: input.expiresAt };
      return metadata;
    }),
    read: vi.fn(async () => ({
      ...metadata,
      credential: authenticated.credential,
      leaseExpiresAt: NOW + 30_000,
    })),
    revoke: vi.fn(async () => {
      metadata = { ...metadata, revision: metadata.revision + 1, expiresAt: null };
    }),
  };
  const protocol: AppleIdProtocol = {
    start: vi.fn(async () => ({
      kind: "trusted-device" as const,
      destination: null,
      phoneNumbers: [],
    })),
    complete: vi.fn(async () => authenticated),
    requestCode: vi.fn(async () => ({
      kind: "sms" as const,
      destination: "••31",
      phoneNumbers: [],
    })),
    dispose: vi.fn(),
  };
  const sessions = new AppleIdSession(
    backend,
    () => protocol,
    () => NOW,
  );
  return {
    sessions,
    backend,
    protocol,
    rotate: () => {
      metadata = { ...metadata, revision: metadata.revision + 1 };
    },
  };
}
const makeRuntime = (authorizeCaller: AppleBackend["authorizeCaller"] = async () => null) => {
  const unused = async (): Promise<never> => {
    throw new Error("Unused ASC path");
  };
  return new AppleRuntime({
    environmentId: "test",
    backend: {
      authorizeCaller,
      accountStatus: unused,
      status: unused,
      heartbeat: unused,
      credential: unused,
      health: unused,
    },
  });
};
afterEach(() => vi.useRealTimers());
describe("Apple ID sessions", () => {
  it("fans out 2FA to every watcher, seals cookies only, and restores without a password", async () => {
    const h = harness();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const off = h.sessions.watch(target, (s) => first.push(s));
    h.sessions.watch(target, (s) => second.push(s));
    const challenge = await h.sessions.start(
      { ...target, password: "NEVER-PERSIST" } as typeof target,
      "NEVER-PERSIST",
    );
    expect(challenge.state).toBe("challenge");
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    if (challenge.state !== "challenge") throw new Error("missing challenge");
    await h.sessions.complete(target, challenge.flowId, "123456");
    expect(first.at(-1)).toEqual({ state: "authenticated", expiresAt: authenticated.expiresAt });
    expect(JSON.stringify(first)).not.toMatch(/SECRET-COOKIE|NEVER-PERSIST|123456/);
    expect(JSON.stringify(vi.mocked(h.backend.status).mock.calls)).not.toContain("NEVER-PERSIST");
    expect(vi.mocked(h.backend.save).mock.calls[0]?.[1]).toEqual({
      accountRevision: 1,
      revision: 0,
      ...authenticated,
    });
    const restored = new AppleIdSession(
      h.backend,
      () => {
        throw new Error("must not log in");
      },
      () => NOW,
    );
    expect(await restored.status(target)).toEqual({
      state: "authenticated",
      expiresAt: authenticated.expiresAt,
    });
    off();
    h.sessions.dispose();
    restored.dispose();
  });
  it("status reads wait for committed sign-in saves without revoking the session", async () => {
    const h = harness();
    const committed = receipt<void>();
    const deliver = receipt<void>();
    const save = h.backend.save;
    h.backend.save = async (account, input) => {
      const metadata = await save(account, input);
      committed.resolve();
      await deliver.promise;
      return metadata;
    };
    const states: (typeof AppleIdSessionState.Type)[] = [];
    h.sessions.watch(target, (state) => states.push(state));
    const challenge = await h.sessions.start(target, "TEST-PASSWORD");
    if (challenge.state !== "challenge") throw new Error("Expected challenge");
    const completion = h.sessions.complete(target, challenge.flowId, "123456");
    const completed = expect(completion).resolves.toEqual({
      state: "authenticated",
      expiresAt: authenticated.expiresAt,
    });
    await committed.promise;
    const reading = h.sessions.status(target);
    deliver.resolve();
    await completed;
    expect(await reading).toEqual({ state: "authenticated", expiresAt: authenticated.expiresAt });
    expect(states.some((state) => state.state === "expired")).toBe(false);
    expect(h.backend.revoke).not.toHaveBeenCalled();
    h.sessions.dispose();
  });
  it("cancellation aborts an in-flight login and fences its late response", async () => {
    const h = harness();
    const held = receipt<AppleAuthenticated>();
    const started = receipt<string>();
    h.protocol.start = vi.fn(() => held.promise);
    h.sessions.watch(target, (state) => {
      if (state.state === "authenticating") started.resolve(state.flowId);
    });
    const pending = h.sessions.start(target, "password");
    const rejected = expect(pending).rejects.toMatchObject({ code: "credential-changed" });
    await h.sessions.cancel(target, await started.promise);
    held.resolve(authenticated);
    await rejected;
    expect(h.backend.save).not.toHaveBeenCalled();
    expect(h.protocol.dispose).toHaveBeenCalled();
    expect(await h.sessions.status(target)).toEqual({ state: "signed-out" });
    h.sessions.dispose();
  });
  it("cancellation during the cloud save revokes the resulting session", async () => {
    const h = harness();
    const entered = receipt<void>();
    const release = receipt<void>();
    const invalidated = receipt<void>();
    const save = h.backend.save;
    h.protocol.dispose = () => invalidated.resolve();
    h.backend.save = async (target, input) => {
      entered.resolve();
      await release.promise;
      return save(target, input);
    };
    const challenge = await h.sessions.start(target, "password");
    if (challenge.state !== "challenge") throw new Error("no challenge");
    const pending = h.sessions.complete(target, challenge.flowId, "123456");
    const rejected = expect(pending).rejects.toMatchObject({ code: "credential-changed" });
    await entered.promise;
    const cancelled = h.sessions.cancel(target, challenge.flowId);
    await invalidated.promise;
    release.resolve();
    await cancelled;
    await rejected;
    expect(await h.sessions.status(target)).toEqual({ state: "signed-out" });
    h.sessions.dispose();
  });
  it("expires challenges, rejects stale flows and drops protocol references", async () => {
    vi.useFakeTimers();
    const h = harness();
    const challenge = await h.sessions.start(target, "password");
    if (challenge.state !== "challenge") throw new Error("no challenge");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await h.sessions.status(target)).toEqual({ state: "expired" });
    await expect(h.sessions.complete(target, challenge.flowId, "123456")).rejects.toMatchObject({
      code: "credential-changed",
    });
    expect(h.protocol.dispose).toHaveBeenCalled();
    h.sessions.dispose();
  });
  it("keeps upstream secrets out of public failures and detects revoked sessions", async () => {
    const h = harness();
    h.protocol.start = async () => {
      throw new Error("password cookie raw response SECRET");
    };
    await expect(h.sessions.start(target, "SECRET")).rejects.toMatchObject({
      message: "Apple sign-in failed. Try again.",
    });
    expect(JSON.stringify(await h.sessions.status(target))).not.toContain("SECRET");
    h.sessions.dispose();
  });
  effectIt.effect("streams live challenges through the actual RPC to two clients", () =>
    Effect.gen(function* () {
      const h = harness();
      const runtime = makeRuntime();
      const rpc = makeAppleRpcHandlers(
        runtime,
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        h.sessions,
        Effect.succeed({ clerkSubject: "owner" }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const ready = receipt<void>();
          let signedOut = 0;
          const stream = rpc["apple.id.subscribe"](target).pipe(
            Stream.tap((state) =>
              Effect.sync(() => {
                if (state.state === "signed-out" && ++signedOut === 2) ready.resolve();
              }),
            ),
            Stream.filter((s) => s.state === "challenge"),
            Stream.take(1),
            Stream.runCollect,
          );
          const a = yield* Effect.forkChild(stream);
          const b = yield* Effect.forkChild(stream);
          yield* Effect.promise(() => ready.promise);
          yield* rpc["apple.id.start"]({ ...target, password: "SECRET" });
          expect(yield* Fiber.join(a)).toEqual(yield* Fiber.join(b));
        }),
      );
      h.sessions.dispose();
      runtime.dispose();
    }),
  );
  it("accepts only one of two concurrent challenge submissions", async () => {
    const h = harness();
    const entered = receipt<void>();
    const release = receipt<void>();
    h.protocol.complete = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return authenticated;
    });
    const state = await h.sessions.start(target, "SECRET");
    if (state.state !== "challenge") throw new Error("Expected challenge");
    const first = h.sessions.complete(target, state.flowId, "123456");
    await entered.promise;
    await expect(h.sessions.complete(target, state.flowId, "123456")).rejects.toMatchObject({
      code: "request-failed",
    });
    expect(h.protocol.complete).toHaveBeenCalledOnce();
    release.resolve();
    expect(await first).toMatchObject({ state: "authenticated" });
    h.sessions.dispose();
  });
  effectIt.effect(
    "denies all Apple ID mutations before reading or changing the account session",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const authorize = vi.fn<AppleBackend["authorizeCaller"]>(async () => {
          throw new AppleError({
            code: "forbidden",
            message: "Account denied",
            retryAfterSeconds: null,
          });
        });
        const runtime = makeRuntime(authorize);
        const rpc = makeAppleRpcHandlers(
          runtime,
          [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          h.sessions,
          Effect.succeed({ userId: "not-owner" }),
        );
        const calls = [
          rpc["apple.id.start"]({ ...target, password: "SECRET" }),
          rpc["apple.id.complete"]({ ...target, flowId: "flow", code: "123456" }),
          rpc["apple.id.requestCode"]({ ...target, flowId: "flow", phoneNumberId: 1 }),
          rpc["apple.id.cancel"]({ ...target, flowId: "flow" }),
          rpc["apple.id.signOut"](target),
        ];
        for (const call of calls)
          expect(yield* Effect.result(call)).toMatchObject({
            _tag: "Failure",
            failure: { code: "forbidden" },
          });
        expect(h.backend.status).not.toHaveBeenCalled();
        expect(h.protocol.start).not.toHaveBeenCalled();
        expect(h.backend.save).not.toHaveBeenCalled();
        for (const [input] of authorize.mock.calls)
          expect(input).toEqual({ ...target, caller: { userId: "not-owner" }, manage: true });
        h.sessions.dispose();
        runtime.dispose();
      }),
  );
  effectIt.effect("closes a live 2FA subscription before emitting after access is revoked", () =>
    Effect.gen(function* () {
      const h = harness();
      const authorize = vi.fn<AppleBackend["authorizeCaller"]>(async () => null);
      const runtime = makeRuntime(authorize);
      const rpc = makeAppleRpcHandlers(
        runtime,
        [AuthOrchestrationReadScope],
        h.sessions,
        Effect.succeed({ clerkSubject: "owner" }),
      );
      const ready = receipt<void>();
      const values: (typeof AppleIdSessionState.Type)[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Stream.runForEach(rpc["apple.id.subscribe"](target), (s) =>
              Effect.sync(() => {
                values.push(s);
                ready.resolve();
              }),
            ).pipe(Effect.result),
          );
          yield* Effect.promise(() => ready.promise);
          authorize.mockRejectedValue(
            new AppleError({
              code: "forbidden",
              message: "Access revoked",
              retryAfterSeconds: null,
            }),
          );
          yield* Effect.promise(() => h.sessions.start(target, "SECRET"));
          expect(yield* Fiber.join(fiber)).toMatchObject({
            _tag: "Failure",
            failure: { code: "forbidden" },
          });
        }),
      );
      expect(values.every((s) => s.state === "signed-out")).toBe(true);
      h.sessions.dispose();
      runtime.dispose();
    }),
  );
});
