// @effect-diagnostics nodeBuiltinImport:off -- Temporary fixture filesystem; every Xcode/simctl invocation is mocked.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DeviceSummary,
  type EnvironmentAuthorizationError,
} from "@spiritdevs/contracts";
import {
  SimBuildError,
  type SimBuildReceipt,
  type SimBuildStartInput,
  type SimBuildUpdate,
} from "@spiritdevs/contracts/simBuild";
import { SimBuildHost } from "./SimBuildHost.ts";
import { SimBuildRuntime } from "./SimBuildRuntime.ts";
import type { SimBuildCommand, SimBuildProcess } from "./SimBuildProcess.ts";
import { makeSimBuildRpcHandlers } from "./simBuildRpc.ts";
import { fileSimBuildStore } from "./SimBuildStore.ts";

const context = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
};
const input: SimBuildStartInput = {
  ...context,
  action: "run",
  requestId: "request",
  hostId: "local",
  deviceId: "SIM-1",
  containerPath: "App.xcodeproj",
  scheme: "App",
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-sim-build-test-"));
  cleanups.push(() => NodeFSP.rm(root, { recursive: true, force: true }));
  await NodeFSP.mkdir(NodePath.join(root, "App.xcodeproj"));
  const calls: SimBuildCommand[] = [];
  let saved: readonly SimBuildReceipt[] = [];
  const store = {
    load: vi.fn(async () => saved),
    save: vi.fn(async (receipts: readonly SimBuildReceipt[]) => {
      saved = structuredClone(receipts);
    }),
  };
  let device: DeviceSummary = {
    hostId: "local",
    id: "SIM-1",
    platform: "ios",
    name: "iPhone",
    version: "iOS 26",
    physical: false,
    booted: true,
  };
  const dependencies = {
    resolve: vi.fn(async () => root),
    destination: vi.fn(async () => device),
    claim: vi.fn(async () => undefined),
  };
  let intercept: SimBuildProcess | undefined;
  const run: SimBuildProcess = async (command, signal, output) => {
    calls.push(command);
    signal.throwIfAborted();
    if (intercept) {
      const result = await intercept(command, signal, output);
      if (result !== "CONTINUE") return result;
    }
    if (command.file === "/usr/bin/xcode-select")
      return "/Applications/Xcode-27.app/Contents/Developer\n";
    if (command.args.includes("-list"))
      return JSON.stringify({
        project: {
          schemes: ["App", "Tests"],
          targets: ["App", "AppTests"],
          configurations: ["Debug", "Release"],
        },
      });
    if (command.args.includes("build")) {
      await output?.("Sources/View.swift:42:7: warning: test warning\n", "stderr");
      await NodeFSP.mkdir(
        NodePath.join(
          command.args[command.args.indexOf("-derivedDataPath") + 1]!,
          "Build/Products/Debug-iphonesimulator/App.app",
        ),
        { recursive: true },
      );
    }
    if (command.args.includes("-showBuildSettings"))
      return JSON.stringify([
        {
          target: "App",
          buildSettings: {
            WRAPPER_EXTENSION: "app",
            PLATFORM_NAME: "iphonesimulator",
            TARGET_BUILD_DIR: NodePath.join(
              command.args[command.args.indexOf("-derivedDataPath") + 1]!,
              "Build/Products/Debug-iphonesimulator",
            ),
            FULL_PRODUCT_NAME: "App.app",
            PRODUCT_BUNDLE_IDENTIFIER: "com.example.app",
          },
        },
      ]);
    return "";
  };
  const host = new SimBuildHost(run, "darwin");
  const runtime = new SimBuildRuntime(NodePath.join(root, ".jobs"), dependencies, store, host);
  cleanups.push(() => runtime.dispose());
  return {
    root,
    calls,
    store,
    host,
    runtime,
    dependencies,
    get saved() {
      return saved;
    },
    setDevice: (value: Partial<DeviceSummary>) => {
      device = { ...device, ...value };
    },
    intercept: (value: SimBuildProcess) => {
      intercept = value;
    },
  };
}

it("builds, installs and launches with selected Xcode, durable ordered receipts and diagnostics", async () => {
  const h = await fixture();
  const job = await h.runtime.start(input);
  const target = { ...context, jobId: job.id };
  expect((await h.runtime.drain(target)).phase).toBe("running");
  const update = await h.runtime.get(target);
  expect(update.receipts.map((r) => r.job.phase)).toEqual([
    "resolving",
    "building",
    "installing",
    "launching",
    "running",
  ]);
  expect(h.saved).toEqual(update.receipts);
  expect(update.logs.flatMap((log) => log.diagnostics)).toContainEqual({
    severity: "warning",
    message: "test warning",
    file: NodePath.join(h.root, "Sources/View.swift"),
    line: 42,
    column: 7,
  });
  const native = h.calls.filter((c) => c.file !== "/usr/bin/xcode-select");
  expect(
    native.every((c) => c.env?.DEVELOPER_DIR === "/Applications/Xcode-27.app/Contents/Developer"),
  ).toBe(true);
  const build = h.calls.findIndex((c) => c.args.includes("build"));
  const install = h.calls.findIndex((c) => c.args.includes("install"));
  const launch = h.calls.findIndex((c) => c.args.includes("launch"));
  expect(build).toBeLessThan(install);
  expect(install).toBeLessThan(launch);
  expect(h.calls[build]?.args).toContain("platform=iOS Simulator,id=SIM-1");
  expect(h.calls[launch]?.args).toEqual([
    "simctl",
    "launch",
    "--terminate-running-process",
    "SIM-1",
    "com.example.app",
  ]);
  expect(h.dependencies.claim).toHaveBeenCalledTimes(3);
});

it.each(["build", "test"] as const)(
  "%s completes without installing or launching",
  async (action) => {
    const h = await fixture();
    const job = await h.runtime.start({ ...input, action });
    expect((await h.runtime.drain({ ...context, jobId: job.id })).phase).toBe("completed");
    expect(h.calls.some((c) => c.args.includes("install") || c.args.includes("launch"))).toBe(
      false,
    );
    expect(h.calls.some((c) => c.args.at(-1) === action)).toBe(true);
  },
);

it.each(["-list", "build", "install", "launch"])(
  "cancel during %s aborts only the active command and drains before receipt",
  async (stage) => {
    const h = await fixture();
    const entered = gate();
    const aborted = gate();
    const closed = gate();
    h.intercept(async (command, signal) => {
      if (!command.args.includes(stage)) return "CONTINUE";
      entered.resolve();
      signal.addEventListener("abort", aborted.resolve, { once: true });
      await closed.promise;
      signal.throwIfAborted();
      return "CONTINUE";
    });
    const job = await h.runtime.start(input);
    const target = { ...context, jobId: job.id };
    await entered.promise;
    const cancellation = h.runtime.cancel(target);
    await aborted.promise;
    expect((await h.runtime.get(target)).job.terminal).toBe(false);
    closed.resolve();
    expect((await cancellation).phase).toBe("cancelled");
    expect(h.saved.at(-1)?.job.phase).toBe("cancelled");
    expect((await h.runtime.drain(target)).phase).toBe("cancelled");
  },
);

it("rejects foreign, SSH, physical, Android and owned destinations before spawning", async () => {
  const h = await fixture();
  await expect(h.runtime.start({ ...input, hostId: "ssh-mac" })).rejects.toMatchObject({
    code: "invalid-destination",
  });
  for (const patch of [
    { id: "different" },
    { id: "SIM-1", physical: true },
    { physical: false, platform: "android" as const },
    { platform: "ios" as const, inUseBy: { environmentId: "other", environmentLabel: "Other" } },
  ]) {
    h.setDevice(patch);
    await expect(h.runtime.start(input)).rejects.toMatchObject({ code: "invalid-destination" });
  }
  expect(h.calls).toEqual([]);
});

it("rechecks ownership after the build and never installs after losing the device", async () => {
  const h = await fixture();
  h.intercept(async (command) => {
    if (command.args.includes("build"))
      h.setDevice({ inUseBy: { environmentId: "other", environmentLabel: "Other" } });
    return "CONTINUE";
  });
  const job = await h.runtime.start(input);
  expect((await h.runtime.drain({ ...context, jobId: job.id })).failure?.code).toBe(
    "invalid-destination",
  );
  expect(h.calls.some((c) => c.args.includes("install"))).toBe(false);
});

it("deduplicates retries, rejects conflicting options and serializes concurrent starts", async () => {
  const h = await fixture();
  const entered = gate();
  const release = gate();
  h.intercept(async (command) => {
    if (command.args.includes("build")) {
      entered.resolve();
      await release.promise;
    }
    return "CONTINUE";
  });
  const [one, two] = await Promise.all([h.runtime.start(input), h.runtime.start(input)]);
  expect(one.id).toBe(two.id);
  await entered.promise;
  await expect(h.runtime.start({ ...input, scheme: "Tests" })).rejects.toMatchObject({
    code: "busy",
  });
  await expect(h.runtime.start({ ...input, requestId: "other" })).rejects.toMatchObject({
    code: "busy",
  });
  release.resolve();
  await h.runtime.drain({ ...context, jobId: one.id });
  expect(h.calls.filter((c) => c.args.includes("build"))).toHaveLength(1);
});

it("fails before installation when xcodebuild fails and persists the error", async () => {
  const h = await fixture();
  h.intercept(async (command, _signal, output) => {
    if (command.args.includes("build")) {
      await output?.("A.swift:2: error: broken\n", "stdout");
      throw new SimBuildError({ code: "process-failed", message: "Build failed" });
    }
    return "CONTINUE";
  });
  const job = await h.runtime.start(input);
  expect((await h.runtime.drain({ ...context, jobId: job.id })).phase).toBe("failed");
  expect(h.calls.some((c) => c.args.includes("install"))).toBe(false);
  expect(h.saved.at(-1)?.job.failure?.code).toBe("process-failed");
});

it("recovers an unfinished durable job as interrupted without spawning a process", async () => {
  const h = await fixture();
  const entered = gate();
  const release = gate();
  h.intercept(async (command) => {
    if (command.args.includes("build")) {
      entered.resolve();
      await release.promise;
    }
    return "CONTINUE";
  });
  const job = await h.runtime.start(input);
  await entered.promise;
  const saved = structuredClone(h.saved);
  const store = { load: async () => saved, save: vi.fn(async () => undefined) };
  const run = vi.fn<SimBuildProcess>();
  const recovered = new SimBuildRuntime(
    h.root,
    h.dependencies,
    store,
    new SimBuildHost(run, "darwin"),
  );
  cleanups.push(() => recovered.dispose());
  const snapshot = await recovered.get({ ...context, jobId: job.id });
  expect(snapshot.job.failure?.code).toBe("interrupted");
  expect(snapshot.job.terminal).toBe(true);
  expect(store.save).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
  release.resolve();
  await h.runtime.drain({ ...context, jobId: job.id });
});

it("refuses to start when receipts cannot be persisted", async () => {
  const h = await fixture();
  h.store.save.mockRejectedValueOnce(new Error("disk full"));
  await expect(h.runtime.start(input)).rejects.toMatchObject({ code: "storage-failed" });
  expect(h.calls).toEqual([]);
});

it.effect("bounds output for a stalled stream consumer and preserves every phase receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* Effect.promise(fixture);
      const entered = gate();
      const flood = gate();
      const subscribed = gate();
      const consume = gate();
      h.intercept(async (command, _signal, output) => {
        if (command.args.includes("build")) {
          entered.resolve();
          await flood.promise;
          for (let i = 0; i < 100; i++) await output?.("z".repeat(16384), "stdout");
        }
        return "CONTINUE";
      });
      const job = yield* Effect.promise(() => h.runtime.start(input));
      yield* Effect.promise(() => entered.promise);
      const target = { ...context, jobId: job.id };
      const rpc = makeSimBuildRpcHandlers(h.runtime, ["orchestration:read"]);
      const updates: SimBuildUpdate[] = [];
      const stream = yield* rpc["simBuild.subscribe"](target).pipe(
        Stream.runForEach((update) =>
          Effect.promise(async () => {
            updates.push(update);
            if (updates.length === 1) {
              subscribed.resolve();
              await consume.promise;
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.promise(() => subscribed.promise);
      flood.resolve();
      yield* Effect.promise(() => h.runtime.drain(target));
      consume.resolve();
      yield* Fiber.join(stream);
      expect(updates).toHaveLength(2);
      expect(updates[1]?.logs.reduce((n, log) => n + log.text.length, 0)).toBeLessThanOrEqual(
        65536,
      );
      expect(updates[1]!.firstLogSequence).toBeGreaterThan(1);
      expect(updates.flatMap((u) => u.receipts.map((r) => r.sequence))).toEqual([1, 2, 3, 4, 5]);
      const reconnect = yield* Stream.runCollect(rpc["simBuild.subscribe"](target));
      expect(reconnect).toHaveLength(1);
      expect(reconnect[0]?.kind).toBe("snapshot");
      expect(reconnect[0]?.job.phase).toBe("running");
    }),
  ),
);

it.effect(
  "authorizes every RPC before touching projects or processes and binds job reads to the thread",
  () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(fixture);
      const rpc = makeSimBuildRpcHandlers(h.runtime, []);
      const target = { ...context, jobId: "unknown" };
      const calls: Effect.Effect<unknown, SimBuildError | EnvironmentAuthorizationError>[] = [
        rpc["simBuild.discover"](context),
        rpc["simBuild.start"](input),
        rpc["simBuild.list"](context),
        rpc["simBuild.get"](target),
        rpc["simBuild.cancel"](target),
        Stream.runCollect(rpc["simBuild.subscribe"](target)),
      ];
      for (const call of calls)
        expect(yield* Effect.result(call)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "EnvironmentAuthorizationError" },
        });
      expect(h.dependencies.resolve).not.toHaveBeenCalled();
      const job = yield* Effect.promise(() => h.runtime.start(input));
      yield* Effect.promise(() => h.runtime.drain({ ...context, jobId: job.id }));
      yield* Effect.promise(() =>
        expect(
          h.runtime.get({ ...context, threadId: ThreadId.make("other"), jobId: job.id }),
        ).rejects.toMatchObject({ code: "not-found" }),
      );
      expect(h.calls.filter((c) => c.args.includes("build"))).toHaveLength(1);
    }),
);

it("discovers Expo ios workspaces and project targets, uses Release and reports missing prebuild", async () => {
  const h = await fixture();
  await NodeFSP.rm(NodePath.join(h.root, "App.xcodeproj"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(h.root, "package.json"),
    JSON.stringify({ dependencies: { expo: "54", "react-native": "0.81" } }),
  );
  expect((await h.runtime.discover(context)).notices[0]).toContain("prebuild");
  await NodeFSP.mkdir(NodePath.join(h.root, "ios/App.xcworkspace"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(h.root, "ios/App.xcodeproj"), { recursive: true });
  const discovery = await h.runtime.discover(context);
  expect(discovery.framework).toBe("expo");
  expect(discovery.containers.map((c) => c.path)).toEqual([
    "ios/App.xcodeproj",
    "ios/App.xcworkspace",
  ]);
  expect(discovery.containers[0]?.targets).toEqual(["App", "AppTests"]);
  const job = await h.runtime.start({ ...input, containerPath: "ios/App.xcworkspace" });
  expect((await h.runtime.drain({ ...context, jobId: job.id })).phase).toBe("running");
  expect(h.calls.find((c) => c.args.includes("build"))?.args).toContain("Release");
});

it("rejects a container symlink escaping the checkout", async () => {
  const h = await fixture();
  const outside = await fixture();
  await NodeFSP.symlink(
    NodePath.join(outside.root, "App.xcodeproj"),
    NodePath.join(h.root, "Escape.xcodeproj"),
  );
  await expect(h.host.resolveContainer(h.root, "Escape.xcodeproj")).rejects.toMatchObject({
    code: "invalid-project",
  });
});

it("atomically round-trips receipt journals and refuses corrupt history", async () => {
  const h = await fixture();
  const job = await h.runtime.start(input);
  await h.runtime.drain({ ...context, jobId: job.id });
  const file = NodePath.join(h.root, "journal/receipts.json");
  const store = fileSimBuildStore(file);
  expect(await store.load()).toEqual([]);
  await store.save(h.saved);
  expect(await store.load()).toEqual(h.saved);
  await NodeFSP.writeFile(file, "broken");
  await expect(store.load()).rejects.toMatchObject({ code: "storage-failed" });
});

it("cancels during initial receipt persistence and drains the pending acceptance", async () => {
  const h = await fixture();
  const entered = gate();
  const saved = gate();
  h.store.save.mockImplementationOnce(async () => {
    entered.resolve();
    await saved.promise;
  });
  const starting = h.runtime.start(input);
  await entered.promise;
  const visible = await h.runtime.list(context);
  const job = visible[0]!;
  let cancelled = false;
  const cancellation = h.runtime.cancel({ ...context, jobId: job.id }).then((result) => {
    cancelled = true;
    return result;
  });
  // Reading the same accepted entry crosses the cancellation lookup without sleeping.
  await h.runtime.get({ ...context, jobId: job.id });
  expect(cancelled).toBe(false);
  saved.resolve();
  await starting;
  expect((await cancellation).phase).toBe("cancelled");
  expect(h.calls).toEqual([]);
});

it("stops before install if the thread switches checkout while building", async () => {
  const h = await fixture();
  h.intercept(async (command) => {
    if (command.args.includes("build"))
      h.dependencies.resolve.mockResolvedValue("/different-worktree");
    return "CONTINUE";
  });
  const job = await h.runtime.start(input);
  expect((await h.runtime.drain({ ...context, jobId: job.id })).failure?.code).toBe(
    "invalid-project",
  );
  expect(h.calls.some((c) => c.args.includes("install"))).toBe(false);
});
