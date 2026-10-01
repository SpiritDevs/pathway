import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { AppleError } from "@spiritdevs/contracts/apple";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  type EnvironmentAuthorizationError,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import type { XcodeStatus, XcodeJob, XcodeError, XcodeUpdate } from "@spiritdevs/contracts/xcode";
import type { AppleRuntime } from "../apple/AppleRuntime.ts";
import { XcodeInstall } from "./XcodeInstall.ts";
import { makeXcodeRpcHandlers } from "./xcodeRpc.ts";
const encodeUpdate = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const target = {
  companyId: CompanyId.make("01990000-0000-7000-8000-000000000011"),
  accountId: "personal",
};
const scopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
const forbidden = () =>
  new AppleError({ code: "forbidden", message: "Account denied", retryAfterSeconds: null });
function harness() {
  const inventory: Omit<XcodeStatus, "job"> = {
    host: "mac",
    installed: [],
    available: [],
    runtimes: [],
    disk: { freeBytes: 100e9, requiredBytes: 45e9 },
    error: null,
  };
  const host = {
    supported: true,
    inspect: vi.fn(async () => inventory),
    installPath: vi.fn(async () => "/Applications/Xcode-27.app"),
    needsAdmin: () => true,
    run: vi.fn(async () => undefined),
  };
  let saved: XcodeJob | null = null;
  const store = {
    load: vi.fn(async () => saved),
    save: vi.fn(async (job: XcodeJob) => {
      saved = job;
    }),
  };
  const runtime = new XcodeInstall(host, store);
  const apple = { authorizeCaller: vi.fn<AppleRuntime["authorizeCaller"]>(async () => null) };
  const rpc = makeXcodeRpcHandlers(
    runtime,
    apple,
    scopes,
    Effect.succeed({ clerkSubject: "owner" }),
  );
  return { runtime, host, store, apple, rpc };
}
it.effect("authorizes every Xcode RPC before inspecting the host or changing a job", () =>
  Effect.gen(function* () {
    const h = harness();
    h.apple.authorizeCaller.mockRejectedValue(forbidden());
    const reads = [h.rpc["xcode.status"](target), Stream.runHead(h.rpc["xcode.subscribe"](target))];
    const writes = [
      h.rpc["xcode.install"]({ ...target, versionId: "27A1", platforms: [] }),
      h.rpc["xcode.select"]({ ...target, path: "/Applications/Xcode.app" }),
      h.rpc["xcode.installRuntimes"]({
        ...target,
        path: "/Applications/Xcode.app",
        platforms: ["iOS"],
      }),
      h.rpc["xcode.cancel"]({ ...target, jobId: "job" }),
      h.rpc["xcode.retry"]({ ...target, jobId: "job" }),
      h.rpc["xcode.approve"]({ ...target, jobId: "job" }),
    ];
    const calls: ReadonlyArray<
      Effect.Effect<unknown, AppleError | XcodeError | EnvironmentAuthorizationError>
    > = [...reads, ...writes];
    for (const call of calls)
      expect(yield* Effect.result(call)).toMatchObject({
        _tag: "Failure",
        failure: { code: "forbidden" },
      });
    expect(h.apple.authorizeCaller.mock.calls.map(([input]) => input)).toEqual([
      ...reads.map(() => ({ ...target, caller: { clerkSubject: "owner" }, manage: false })),
      ...writes.map(() => ({ ...target, caller: { clerkSubject: "owner" }, manage: true })),
    ]);
    expect(h.store.load).not.toHaveBeenCalled();
    expect(h.host.inspect).not.toHaveBeenCalled();
    expect(h.host.run).not.toHaveBeenCalled();
    const unknown = makeXcodeRpcHandlers(h.runtime, h.apple, scopes);
    expect(yield* Effect.result(unknown["xcode.status"](target))).toMatchObject({
      _tag: "Failure",
      failure: { code: "forbidden" },
    });
    yield* Effect.promise(() => h.runtime.dispose());
  }),
);
it.effect("does not expose or operate on a job through another account context", () =>
  Effect.gen(function* () {
    const h = harness();
    const job = yield* h.rpc["xcode.select"]({ ...target, path: "/Applications/Xcode.app" });
    yield* Effect.promise(() => h.runtime.drained());
    expect(job.account).toEqual(target);
    const other = { ...target, accountId: "company-account" };
    expect((yield* h.rpc["xcode.status"](other)).job).toBeNull();
    for (const method of ["xcode.cancel", "xcode.retry", "xcode.approve"] as const)
      expect(yield* Effect.result(h.rpc[method]({ ...other, jobId: job.id }))).toMatchObject({
        _tag: "Failure",
        failure: { code: "not-found" },
      });
    expect((yield* h.rpc["xcode.status"](target)).job?.state).toBe("needs-admin");
    yield* h.rpc["xcode.cancel"]({ ...target, jobId: job.id });
    expect((yield* h.rpc["xcode.status"](target)).job?.state).toBe("cancelled");
    yield* Effect.promise(() => h.runtime.dispose());
  }),
);
it.effect(
  "withholds in-flight status after owner unlink and closes a revoked progress stream",
  () =>
    Effect.gen(function* () {
      const h = harness();
      let linked = true;
      const rpc = makeXcodeRpcHandlers(
        h.runtime,
        h.apple,
        scopes,
        Effect.sync(() => (linked ? { clerkSubject: "owner" } : null)),
      );
      const inspect = h.host.inspect.getMockImplementation()!;
      h.host.inspect.mockImplementation(async () => {
        linked = false;
        return inspect();
      });
      expect(yield* Effect.result(rpc["xcode.status"](target))).toMatchObject({
        _tag: "Failure",
        failure: { code: "forbidden" },
      });
      linked = true;
      h.host.inspect.mockImplementation(inspect);
      let emit: ((status: XcodeStatus) => void) | undefined;
      const unsubscribe = vi.fn();
      vi.spyOn(h.runtime, "watch").mockImplementation((listener) => {
        emit = listener;
        return unsubscribe;
      });
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const values: XcodeUpdate[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Stream.runForEach(rpc["xcode.subscribe"](target), (s) =>
              Effect.sync(() => {
                values.push(s);
                ready();
              }),
            ).pipe(Effect.result),
          );
          yield* Effect.promise(() => started);
          h.apple.authorizeCaller.mockRejectedValue(forbidden());
          emit!({ ...inventorySnapshot(), job: null });
          expect(yield* Fiber.join(fiber)).toMatchObject({
            _tag: "Failure",
            failure: { code: "forbidden" },
          });
        }),
      );
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(values.length).toBeGreaterThan(0);
      yield* Effect.promise(() => h.runtime.dispose());
    }),
);
function inventorySnapshot(): Omit<XcodeStatus, "job"> {
  return {
    host: "mac",
    installed: [],
    available: [],
    runtimes: [],
    disk: { freeBytes: 0, requiredBytes: 0 },
    error: null,
  };
}

it.effect("keeps cached catalogues out of coalesced progress snapshots", () =>
  Effect.gen(function* () {
    const h = harness();
    const inventory = inventorySnapshot();
    h.host.inspect.mockResolvedValue({
      ...inventory,
      available: Array.from({ length: 500 }, (_, i) => ({
        id: `build-${i}`,
        version: "27",
        build: `build-${i}`,
        beta: true,
        downloadBytes: null,
        requiredBytes: 45e9,
      })),
    });
    let ready!: () => void;
    const initial = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let first: XcodeUpdate | undefined;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          h.rpc["xcode.subscribe"](target).pipe(
            Stream.tap((update) =>
              Effect.sync(() => {
                if (update.kind === "status") {
                  first = update;
                  ready();
                }
              }),
            ),
            Stream.filter((update) => update.kind === "job"),
            Stream.take(1),
            Stream.runCollect,
          ),
        );
        yield* Effect.promise(() => initial);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        yield* h.rpc["xcode.select"]({ ...target, path: "/Applications/Xcode.app" });
        yield* Effect.promise(() => h.runtime.drained());
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(350));
        const values = yield* Fiber.join(fiber);
        expect(values[0]).toMatchObject({ kind: "job", job: { state: "needs-admin" } });
        expect(encodeUpdate(first).length).toBeGreaterThan(50_000);
        expect(encodeUpdate(values[0]).length).toBeLessThan(3000);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
    yield* Effect.promise(() => h.runtime.dispose());
  }),
);
