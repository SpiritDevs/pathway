import * as Layer from "effect/Layer";
import { SimBuildHost } from "../../../simBuild/SimBuildHost.ts";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@spiritdevs/contracts";
import { SimBuildRuntime } from "../../../simBuild/SimBuildRuntime.ts";
import { SimBuildService } from "../../../simBuild/SimBuildService.ts";
import {
  McpInvocationContext,
  type McpCapability,
  type McpInvocationScope,
} from "../../McpInvocationContext.ts";
import { ServerSettingsService, layerTest } from "../../../serverSettings.ts";
import { simBuildToolHandlers } from "./handlers.ts";
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerDriverKind: ProviderDriverKind.make("codex"),
  capabilities: new Set(["device"]),
  issuedAt: 1,
  requestIdempotencyKey: "mcp-request",
};
const options = {
  hostId: "local",
  deviceId: "sim",
  containerPath: "ios/App.xcworkspace",
  scheme: "App",
};
function fixture() {
  const runtime = new SimBuildRuntime(
    "/unused",
    { resolve: vi.fn(), destination: vi.fn(), claim: vi.fn() },
    { load: vi.fn(), save: vi.fn() },
    new SimBuildHost(async () => "", "darwin"),
  );
  const discover = vi.spyOn(runtime, "discover").mockImplementation(async (input) => ({
    ...input,
    workspaceRoot: "/worktree",
    framework: "xcode",
    developerDir: "/xcode",
    containers: [],
    notices: [],
  }));
  const start = vi.spyOn(runtime, "start").mockImplementation(async (input) => ({
    ...input,
    id: "job",
    workspaceRoot: "/worktree",
    developerDir: null,
    phase: "resolving",
    terminal: false,
    artifact: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1,
  }));
  return { runtime, start, discover };
}
it.effect(
  "binds all build actions to the calling environment/project/thread and retains retry identity",
  () =>
    Effect.gen(function* () {
      const h = fixture();
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({
          enableDeviceSupport: true,
          enableAgentDeviceAccess: true,
        });
        yield* simBuildToolHandlers.device_build_discover();
        yield* simBuildToolHandlers.device_build({ ...options, requestId: "explicit" });
        yield* simBuildToolHandlers.device_run(options);
        yield* simBuildToolHandlers.device_test(options);
      }).pipe(
        Effect.provide(Layer.mergeAll(layerTest(), NodeServices.layer)),
        Effect.provideService(McpInvocationContext, invocation),
        Effect.provideService(SimBuildService, h.runtime),
      );
      expect(h.discover).toHaveBeenCalledWith(
        { environmentId: "env", projectId: "project", threadId: "thread" },
        expect.any(AbortSignal),
      );
      expect(h.start.mock.calls.map(([input]) => [input.action, input.requestId])).toEqual([
        ["build", "explicit"],
        ["run", "mcp-request"],
        ["test", "mcp-request"],
      ]);
      expect(
        h.start.mock.calls.every(
          ([input]) =>
            input.environmentId === "env" &&
            input.projectId === "project" &&
            input.threadId === "thread",
        ),
      ).toBe(true);
    }),
);
it.effect("denies calls after consent revocation and without device capability", () =>
  Effect.gen(function* () {
    const h = fixture();
    yield* Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({ enableDeviceSupport: true, enableAgentDeviceAccess: true });
      expect(
        yield* Effect.result(
          simBuildToolHandlers.device_run(options).pipe(
            Effect.provideService(McpInvocationContext, {
              ...invocation,
              capabilities: new Set<McpCapability>(),
            }),
          ),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } });
      yield* settings.updateSettings({ enableAgentDeviceAccess: false });
      for (const effect of [
        simBuildToolHandlers.device_build_discover().pipe(Effect.asVoid),
        simBuildToolHandlers.device_run(options).pipe(Effect.asVoid),
        simBuildToolHandlers.device_build_status({ jobId: "job" }).pipe(Effect.asVoid),
        simBuildToolHandlers.device_build_wait({ jobId: "job" }).pipe(Effect.asVoid),
        simBuildToolHandlers.device_build_cancel({ jobId: "job" }).pipe(Effect.asVoid),
      ]) {
        expect(yield* Effect.result(effect)).toMatchObject({
          _tag: "Failure",
          failure: { code: "unavailable" },
        });
      }
    }).pipe(
      Effect.provide(Layer.mergeAll(layerTest(), NodeServices.layer)),
      Effect.provideService(McpInvocationContext, invocation),
      Effect.provideService(SimBuildService, h.runtime),
    );
    expect(h.start).not.toHaveBeenCalled();
    expect(h.discover).not.toHaveBeenCalled();
  }),
);
